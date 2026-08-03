import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AccountUsageService } from "../src/account/application.js";
import { AliyunBillExporter, formatBillStatusLine, parseAgentBayBillRows } from "../src/account/aliyun-billing.js";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
];

test("账户用量服务分页列出全部运行沙盒并计算 Basic 并行与小时估算", async () => {
  const pages: number[] = [];
  let metricLookups = 0;
  const client = {
    list: async (_labels: Record<string, string>, page = 1) => {
      pages.push(page);
      return {
        success: true,
        totalCount: 3,
        sessionIds: page === 1
          ? ids.slice(0, 2).map((sessionId) => ({ sessionId, sessionStatus: "RUNNING", imageId: "code_latest" }))
          : [{ sessionId: ids[2], sessionStatus: "RUNNING", imageId: "browser_latest" }],
      };
    },
    get: async (sessionId: string) => {
      metricLookups++;
      return sessionId === ids[2]
        ? { success: false }
        : {
            success: true,
            session: {
              getMetrics: async () => ({
                success: true,
                data: { cpuCount: 2, memTotal: 4 * 1024 ** 3 },
              }),
              delete: async () => ({ success: true }),
            },
          };
    },
  };

  const service = new AccountUsageService(client, {
    parallelLimit: 10,
    pageSize: 2,
    cpuCnyPerCoreHour: 0.12,
    cpuCnyPerCoreHourHigh: 0.2,
    memoryCnyPerGiBHour: 0.05,
  });
  const snapshot = await service.snapshot();

  assert.deepEqual(pages, [1, 2]);
  assert.equal(snapshot.running, 3);
  assert.equal(snapshot.parallelLimit, 10);
  assert.equal(snapshot.utilizationPercent, 30);
  assert.equal(snapshot.sessions.length, 3);
  assert.equal(snapshot.sessions[0].cpuCount, 2);
  assert.equal(snapshot.sessions[0].memoryGiB, 4);
  assert.equal(snapshot.sessions[0].estimatedCnyPerHour, 0.44);
  assert.equal(snapshot.sessions[0].estimatedCnyPerHourHigh, 0.6);
  assert.equal(snapshot.sessions[2].estimatedCnyPerHour, undefined);
  assert.equal(snapshot.estimatedCnyPerHour, 0.88);
  assert.equal(snapshot.estimatedCnyPerHourHigh, 1.2);
  assert.equal(snapshot.estimatedSessionCount, 2);
  assert.equal(metricLookups, 3);

  const listOnly = await service.snapshot({ includeMetrics: false });
  assert.equal(metricLookups, 3);
  assert.equal(listOnly.estimatedCnyPerHour, 0.88);
  assert.equal(listOnly.estimatedCnyPerHourHigh, 1.2);
  assert.equal(listOnly.estimatedSessionCount, 2);
});

test("账户用量服务拒绝远端列表失败和无效 Basic 上限", async () => {
  const failed = { list: async () => ({ success: false, sessionIds: [], errorMessage: "remote failed" }), get: async () => ({ success: false }) };
  await assert.rejects(new AccountUsageService(failed).snapshot(), /remote failed/);
  assert.throws(() => new AccountUsageService(failed, { parallelLimit: 0 }), /parallelLimit/);
});

test("全量停机先完成 RUNNING 分页快照，再并发删除并报告部分失败", async () => {
  const events: string[] = [];
  const client = {
    list: async (_labels: Record<string, string>, page = 1) => {
      events.push(`list:${page}`);
      return {
        success: true,
        totalCount: 3,
        sessionIds: page === 1
          ? ids.slice(0, 2).map((sessionId) => ({ sessionId, sessionStatus: "RUNNING" }))
          : [{ sessionId: ids[2], sessionStatus: "RUNNING" }],
      };
    },
    get: async (sessionId: string) => {
      events.push(`get:${sessionId}`);
      if (sessionId === ids[2]) return { success: false, errorMessage: "not found" };
      return {
        success: true,
        session: {
          getMetrics: async () => ({ success: false }),
          delete: async () => {
            events.push(`delete:${sessionId}`);
            return sessionId === ids[1] ? { success: false, errorMessage: "denied" } : { success: true };
          },
        },
      };
    },
  };

  const result = await new AccountUsageService(client, { pageSize: 2 }).shutdownAllRunning();

  assert.deepEqual(events.slice(0, 2), ["list:1", "list:2"]);
  assert.equal(result.attempted, 3);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.failures, [
    { sessionId: ids[1], error: "denied" },
    { sessionId: ids[2], error: "not found" },
  ]);
});

test("消费解析只统计 AgentBay 按量消费，不把已购套餐算成资源花费", () => {
  const parsed = parseAgentBayBillRows({
    Code: "Success",
    Data: {
      Items: [
        {
          ProductCode: "gws",
          ProductName: "无影云电脑",
          ProductType: "gws_agentbaypackage_public_cn",
          ProductDetail: "无影AI Agent专用云环境积分包",
          BillingItem: "会话时长抵扣包定价",
          SubscriptionType: "Subscription",
          Item: "SubscriptionOrder",
          PretaxGrossAmount: 120,
          InvoiceDiscount: 119.99,
          PretaxAmount: 0.01,
          Currency: "CNY",
        },
        {
          ProductCode: "gws",
          ProductName: "无影云电脑",
          ProductType: "gws_agentbay_public_cn",
          ProductDetail: "AgentBay计算资源",
          BillingItem: "CPU",
          SubscriptionType: "PayAsYouGo",
          Item: "PayAsYouGoBill",
          PretaxGrossAmount: 0.2,
          InvoiceDiscount: 0.05,
          PretaxAmount: 0.15,
          Currency: "CNY",
        },
      ],
    },
  });

  assert.throws(() => parseAgentBayBillRows({ Code: "Failed", Message: "denied" }), /denied/);
  assert.deepEqual(parseAgentBayBillRows({ Code: "Success", Data: { Items: { Item: [] } } }), []);

  assert.deepEqual(parsed, [{
    productCode: "gws",
    productName: "无影云电脑",
    productType: "gws_agentbay_public_cn",
    productDetail: "AgentBay计算资源",
    billingItem: "CPU",
    subscriptionType: "PayAsYouGo",
    pretaxGrossAmount: 0.2,
    invoiceDiscount: 0.05,
    pretaxAmount: 0.15,
    currency: "CNY",
  }]);
});

test("状态行展示官方已入账按量消费并区分读取、零消费和失败状态", () => {
  assert.equal(formatBillStatusLine(undefined, true), "BSS 官方消费读取中…");
  assert.equal(formatBillStatusLine(), "BSS 官方消费尚未读取");
  assert.equal(formatBillStatusLine({
    cycle: "2026-07",
    totalPretaxGrossAmount: 0.6,
    totalInvoiceDiscount: 0.1,
    totalPretaxAmount: 0.5,
  }), "BSS 2026-07 · 已入账按量消费 ¥0.60 · 折后应付 ¥0.50 · 运行中费用可能延迟");
  assert.equal(formatBillStatusLine({
    cycle: "2026-07",
    totalPretaxGrossAmount: 0,
    totalInvoiceDiscount: 0,
    totalPretaxAmount: 0,
  }), "BSS 2026-07 · 已入账按量消费 ¥0.00 · 运行中费用可能延迟");
  assert.equal(formatBillStatusLine(undefined, false, "CLI 不可用"), "BSS 消费读取失败：CLI 不可用");
  const posted = { cycle: "2026-07", totalPretaxGrossAmount: 0.6, totalInvoiceDiscount: 0.1, totalPretaxAmount: 0.5 };
  assert.equal(formatBillStatusLine(posted, true), "BSS 2026-07 · 已入账按量消费 ¥0.60 · 折后应付 ¥0.50 · 运行中费用可能延迟 · 刷新中…");
  assert.equal(formatBillStatusLine(posted, false, "超时"), "BSS 2026-07 · 已入账按量消费 ¥0.60 · 折后应付 ¥0.50 · 运行中费用可能延迟 · 刷新失败：超时");
});

test("官方按量消费导出使用固定 BssOpenApi 调用并以 0600 写入脱敏 JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentbay-bill-test-"));
  const calls: string[][] = [];
  try {
    const exporter = new AliyunBillExporter({
      outputDirectory: directory,
      runCli: async (args) => {
        calls.push(args);
        return JSON.stringify(calls.length === 1 ? {
          Code: "Success",
          RequestId: "must-not-be-exported",
          Data: { NextToken: "next-page", Items: [{ ProductCode: "gws", ProductName: "无影云电脑", ProductType: "gws_agentbay_public_cn", ProductDetail: "AgentBay计算资源", BillingItem: "CPU", SubscriptionType: "PayAsYouGo", Item: "PayAsYouGoBill", PretaxGrossAmount: 0.2, InvoiceDiscount: 0.05, PretaxAmount: 0.15, Currency: "CNY" }] },
        } : {
          Code: "Success",
          Data: { Items: [{ ProductCode: "gws", ProductName: "无影云电脑", ProductType: "gws_agentbay_public_cn", ProductDetail: "AgentBay计算资源", BillingItem: "内存", SubscriptionType: "PayAsYouGo", Item: "PayAsYouGoBill", PretaxGrossAmount: 0.4, InvoiceDiscount: 0.05, PretaxAmount: 0.35, Currency: "CNY" }] },
        });
      },
    });
    const result = await exporter.export(new Date("2026-07-29T00:00:00Z"));

    const baseArgs = ["bssopenapi", "DescribeInstanceBill", "--BillingCycle", "2026-07", "--Granularity", "MONTHLY", "--IsBillingItem", "true", "--IsHideZeroCharge", "false", "--MaxResults", "300", "--ProductCode", "gws", "--SubscriptionType", "PayAsYouGo"];
    assert.deepEqual(calls, [baseArgs, [...baseArgs, "--NextToken", "next-page"]]);
    assert.equal(result.cycle, "2026-07");
    assert.equal(result.totalPretaxGrossAmount, 0.6);
    assert.equal(result.totalInvoiceDiscount, 0.1);
    assert.equal(result.totalPretaxAmount, 0.5);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    const body = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(body.rows[0].billingItem, "CPU");
    assert.equal(body.rows[1].billingItem, "内存");
    assert.equal(body.source, "Aliyun BssOpenApi.DescribeInstanceBill");
    assert.equal(JSON.stringify(body).includes("RequestId"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
