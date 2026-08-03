import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type AgentBayBillRow = {
  productCode: string;
  productName: string;
  productType: string;
  productDetail: string;
  billingItem: string;
  subscriptionType: string;
  pretaxGrossAmount: number;
  invoiceDiscount: number;
  pretaxAmount: number;
  currency: string;
};

export type AgentBaySpendSnapshot = {
  path: string;
  cycle: string;
  rows: AgentBayBillRow[];
  totalPretaxGrossAmount: number;
  totalInvoiceDiscount: number;
  totalPretaxAmount: number;
};

type SpendStatusSnapshot = Pick<AgentBaySpendSnapshot, "cycle" | "totalPretaxGrossAmount" | "totalInvoiceDiscount" | "totalPretaxAmount">;

export function formatBillStatusLine(snapshot?: SpendStatusSnapshot, loading = false, error = ""): string {
  if (!snapshot) {
    if (loading) return "BSS 官方消费读取中…";
    return error ? `BSS 消费读取失败：${error}` : "BSS 官方消费尚未读取";
  }
  const gross = snapshot.totalPretaxGrossAmount.toFixed(2);
  const charged = snapshot.totalPretaxAmount.toFixed(2);
  const amount = snapshot.totalPretaxGrossAmount > 0
    ? `已入账按量消费 ¥${gross} · 折后应付 ¥${charged}`
    : "已入账按量消费 ¥0.00";
  return `BSS ${snapshot.cycle} · ${amount} · 运行中费用可能延迟${loading ? " · 刷新中…" : error ? ` · 刷新失败：${error}` : ""}`;
}

type BillExporterOptions = {
  outputDirectory?: string;
  runCli?: (args: string[]) => Promise<string>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function amount(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseAgentBayBillRows(value: unknown): AgentBayBillRow[] {
  const root = record(value);
  if (root.Code !== undefined && root.Code !== "Success") throw new Error(`BSS 消费查询失败：${String(root.Message || root.Code)}`);
  const data = record(root.Data);
  const nestedItems = record(data.Items).Item;
  const items = Array.isArray(data.Items) ? data.Items : Array.isArray(nestedItems) ? nestedItems : [];

  return items.flatMap((raw): AgentBayBillRow[] => {
    const item = record(raw);
    const productType = String(item.ProductType || "");
    const productDetail = String(item.ProductDetail || "");
    const subscriptionType = String(item.SubscriptionType || "");
    const itemType = String(item.Item || "");
    const identity = `${item.ProductCode || ""} ${item.ProductName || ""} ${productType} ${productDetail}`;
    if (!/agent\s*bay|agentbay|无影.*ai\s*agent/iu.test(identity) || subscriptionType !== "PayAsYouGo" && itemType !== "PayAsYouGoBill") return [];
    return [{
      productCode: String(item.ProductCode || ""),
      productName: String(item.ProductName || ""),
      productType,
      productDetail,
      billingItem: String(item.BillingItem || ""),
      subscriptionType,
      pretaxGrossAmount: amount(item.PretaxGrossAmount),
      invoiceDiscount: amount(item.InvoiceDiscount),
      pretaxAmount: amount(item.PretaxAmount),
      currency: String(item.Currency || "CNY"),
    }];
  });
}

function billingCycle(date: Date): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}`;
}

async function runAliyun(args: string[]): Promise<string> {
  const profile = process.env.ALIYUN_PROFILE?.trim();
  const cliArgs = profile ? ["--profile", profile, ...args] : args;
  const { stdout } = await execFileAsync("aliyun", cliArgs, { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  return stdout;
}

export class AliyunBillExporter {
  private readonly outputDirectory: string;
  private readonly runCli: (args: string[]) => Promise<string>;

  constructor(options: BillExporterOptions = {}) {
    this.outputDirectory = resolve(options.outputDirectory || process.env.AGENTBAY_BILL_DIR || "/tmp");
    this.runCli = options.runCli || runAliyun;
  }

  async export(date = new Date()): Promise<AgentBaySpendSnapshot> {
    const cycle = billingCycle(date);
    const baseArgs = ["bssopenapi", "DescribeInstanceBill", "--BillingCycle", cycle, "--Granularity", "MONTHLY", "--IsBillingItem", "true", "--IsHideZeroCharge", "false", "--MaxResults", "300", "--ProductCode", "gws", "--SubscriptionType", "PayAsYouGo"];
    const rows: AgentBayBillRow[] = [];
    const seenTokens = new Set<string>();
    let nextToken = "";
    try {
      do {
        const response = JSON.parse(await this.runCli(nextToken ? [...baseArgs, "--NextToken", nextToken] : baseArgs));
        rows.push(...parseAgentBayBillRows(response));
        nextToken = String(record(record(response).Data).NextToken || "");
        if (nextToken && seenTokens.has(nextToken)) throw new Error("BSS 返回了重复的 NextToken");
        seenTokens.add(nextToken);
      } while (nextToken);
    } catch (error) {
      throw new Error(`无法读取阿里云官方消费：${error instanceof Error ? error.message : String(error)}`);
    }
    const total = (key: "pretaxGrossAmount" | "invoiceDiscount" | "pretaxAmount") => Math.round(rows.reduce((sum, row) => sum + row[key], 0) * 10_000) / 10_000;
    const totalPretaxGrossAmount = total("pretaxGrossAmount");
    const totalInvoiceDiscount = total("invoiceDiscount");
    const totalPretaxAmount = total("pretaxAmount");
    const path = join(this.outputDirectory, `agentbay-spend-${cycle}.json`);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = {
      source: "Aliyun BssOpenApi.DescribeInstanceBill",
      cycle,
      exportedAt: new Date().toISOString(),
      note: rows.length ? "金额为阿里云官方 BSS 已入账的 AgentBay 按量消费，不含预付费套餐。" : "当前没有已入账的 AgentBay 按量消费；运行中或刚结束的会话费用可能尚未入账。",
      totalPretaxGrossAmount,
      totalInvoiceDiscount,
      totalPretaxAmount,
      rows,
    };

    await mkdir(this.outputDirectory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return { path, cycle, rows, totalPretaxGrossAmount, totalInvoiceDiscount, totalPretaxAmount };
  }
}
