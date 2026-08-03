import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AccountUsageSnapshot } from "./account/application.js";
import { formatBillStatusLine, type AgentBaySpendSnapshot } from "./account/aliyun-billing.js";
import { AgentChatSession, EFFORT, MODEL, REASONING } from "./agent.js";
import type { PreviewState } from "./preview/application.js";
import {
  createAccountUsageService,
  createAgentChatSession,
  createAliyunBillExporter,
  rescueAgentChatSession,
} from "./composition.js";
import { safeMessage, type SandboxStatus } from "./sandbox.js";
import { archiveAndDestroy } from "./session/application.js";
import { parseSessionCommand } from "./session/commands.js";

type Message = { id: number; role: "user" | "assistant" | "system"; text: string };
type ProcessStep = { id: number; text: string };

function errorText(error: unknown): string {
  return safeMessage(error);
}

export function App(): React.JSX.Element {
  const { exit } = useApp();
  const nextId = useRef(1);
  const nextProcessId = useRef(1);
  const sessionRef = useRef<AgentChatSession | undefined>(undefined);
  const accountServiceRef = useRef<ReturnType<typeof createAccountUsageService> | undefined>(undefined);
  const billExporterRef = useRef<ReturnType<typeof createAliyunBillExporter> | undefined>(undefined);
  const accountRefreshRef = useRef<Promise<AccountUsageSnapshot> | undefined>(undefined);
  const billRefreshRef = useRef<Promise<AgentBaySpendSnapshot> | undefined>(undefined);
  const quitting = useRef(false);
  const [messages, setMessages] = useState<Message[]>([
    { id: 0, role: "system", text: "输入问题开始；前端任务会发布临时预览；/takeover 人工接管浏览器；/exit 保存并销毁。" },
  ]);
  const [input, setInput] = useState("");
  const [processSteps, setProcessSteps] = useState<ProcessStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("正在启动独立沙盒…");
  const [sandboxState, setSandboxState] = useState("new");
  const [accountUsage, setAccountUsage] = useState<AccountUsageSnapshot | undefined>(undefined);
  const [accountError, setAccountError] = useState("");
  const [billSpend, setBillSpend] = useState<AgentBaySpendSnapshot | undefined>(undefined);
  const [billLoading, setBillLoading] = useState(true);
  const [billError, setBillError] = useState("");
  const [preview, setPreview] = useState<PreviewState | undefined>(undefined);

  if (!accountServiceRef.current) accountServiceRef.current = createAccountUsageService();
  if (!billExporterRef.current) billExporterRef.current = createAliyunBillExporter();

  const refreshAccountUsage = useCallback(async (includeMetrics = true, detectExternalShutdown = false): Promise<AccountUsageSnapshot> => {
    if (accountRefreshRef.current) return accountRefreshRef.current;
    const pending = accountServiceRef.current!.snapshot({ includeMetrics }).then(async (snapshot) => {
      setAccountUsage(snapshot);
      setAccountError("");
      const current = sessionRef.current;
      const currentId = current?.sandboxSessionId;
      if (detectExternalShutdown && currentId && !snapshot.sessions.some((session) => session.sessionId === currentId)) {
        await current.close("reset");
        if (sessionRef.current === current) sessionRef.current = undefined;
        setSandboxState("destroyed");
        setPreview(undefined);
        setStatus("当前沙盒已从其他入口关闭；下一次提问或 /new 将创建新沙盒");
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: "检测到当前沙盒已被 LAN Web 或本机命令关闭。" }]);
      }
      return snapshot;
    }).catch((error) => {
      setAccountError(errorText(error));
      throw error;
    }).finally(() => {
      if (accountRefreshRef.current === pending) accountRefreshRef.current = undefined;
    });
    accountRefreshRef.current = pending;
    return pending;
  }, []);

  const refreshBillSpend = useCallback(async (): Promise<AgentBaySpendSnapshot> => {
    if (billRefreshRef.current) return billRefreshRef.current;
    setBillLoading(true);
    const pending = billExporterRef.current!.export().then((snapshot) => {
      setBillSpend(snapshot);
      setBillError("");
      return snapshot;
    }).catch((error) => {
      setBillError(errorText(error));
      throw error;
    }).finally(() => {
      setBillLoading(false);
      if (billRefreshRef.current === pending) billRefreshRef.current = undefined;
    });
    billRefreshRef.current = pending;
    return pending;
  }, []);

  const appendProcess = useCallback((text: string) => {
    setProcessSteps((steps) => steps.at(-1)?.text === text
      ? steps
      : [...steps.slice(-6), { id: nextProcessId.current++, text }]);
  }, []);

  const onSandboxStatus = useCallback((value: SandboxStatus) => {
    setSandboxState(value.state);
    setStatus(value.detail);
  }, []);

  const makeSession = useCallback(() => createAgentChatSession(onSandboxStatus), [onSandboxStatus]);
  if (!sessionRef.current) sessionRef.current = makeSession();

  const start = useCallback(async () => {
    try {
      await sessionRef.current?.start();
    } catch (error) {
      setStatus(errorText(error));
    } finally {
      await refreshAccountUsage().catch(() => undefined);
    }
  }, [refreshAccountUsage]);

  const quit = useCallback(async () => {
    if (quitting.current) return;
    quitting.current = true;
    setStatus("正在保存会话并销毁 AgentBay 沙盒…");
    const current = sessionRef.current;
    try {
      const result = current ? await archiveAndDestroy({
        archive: () => current.archive(),
        destroy: () => current.close(),
      }) : {};
      setStatus(result.archivePath ? `已保存 ${result.archivePath}；沙盒已销毁` : "沙盒已销毁（尚无聊天记录）");
      exit();
    } catch (error) {
      quitting.current = false;
      setStatus(`保存失败，已取消退出：${errorText(error)}`);
    }
  }, [exit]);

  useEffect(() => {
    void start();
    void refreshBillSpend().catch(() => undefined);
    const refreshTimer = setInterval(() => void refreshAccountUsage(false, true).catch(() => undefined), 30_000);
    refreshTimer.unref();
    const stop = () => void quit();
    process.once("SIGTERM", stop);
    process.once("SIGHUP", stop);
    return () => {
      clearInterval(refreshTimer);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      void sessionRef.current?.close();
    };
  }, [quit, refreshAccountUsage, refreshBillSpend, start]);

  useInput((value, key) => {
    if (key.escape && busy) {
      sessionRef.current?.abort();
      setStatus("正在中止当前请求…");
    }
    if (key.ctrl && value === "c") void quit();
  });

  const submit = useCallback(async (raw: string) => {
    const command = parseSessionCommand(raw);
    if (command.type === "prompt" && !command.text || busy) return;
    setInput("");

    if (command.type === "exit") return void quit();
    if (command.type === "error") {
      setMessages((items) => [...items, { id: nextId.current++, role: "system", text: command.message }]);
      return;
    }
    if (command.type === "new") {
      setBusy(true);
      const current = sessionRef.current;
      try {
        const archived = current ? await archiveAndDestroy({
          archive: () => current.archive(),
          destroy: () => current.close("reset"),
        }) : {};
        sessionRef.current = makeSession();
        setPreview(undefined);
        setMessages([{ id: nextId.current++, role: "system", text: archived.archivePath
          ? `旧会话已保存：${archived.archivePath}；正在创建全新沙盒。`
          : "已创建全新对话；正在分配新的 AgentBay 沙盒。" }]);
        await start();
      } catch (error) {
        setStatus(`无法创建新会话：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "resume") {
      setBusy(true);
      let rescued: Awaited<ReturnType<typeof rescueAgentChatSession>> | undefined;
      try {
        rescued = await rescueAgentChatSession(command.path, onSandboxStatus);
        const current = sessionRef.current;
        if (current) await archiveAndDestroy({
          archive: () => current.archive(),
          destroy: () => current.close("reset"),
        });
        sessionRef.current = rescued.session;
        setPreview(undefined);
        setMessages([{ id: nextId.current++, role: "system", text: `已从 ${rescued.path} 救援 Claude 会话；正在创建新的 AgentBay 沙盒。` }]);
        await start();
      } catch (error) {
        await rescued?.session.close("reset");
        setStatus(`恢复失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "sandboxes") {
      setBusy(true);
      try {
        const snapshot = await refreshAccountUsage(true, true);
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: `远端沙盒已刷新：${snapshot.running}/${snapshot.parallelLimit} 并行，参考估算 ¥${snapshot.estimatedCnyPerHour.toFixed(2)}–${snapshot.estimatedCnyPerHourHigh.toFixed(2)}/小时。` }]);
      } catch (error) {
        setStatus(`远端盘点失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "bill") {
      setBusy(true);
      try {
        const bill = await refreshBillSpend();
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: `官方 BSS 按量消费已刷新：${formatBillStatusLine(bill)}；明细 ${bill.path}` }]);
      } catch (error) {
        setStatus(`消费刷新失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "preview") {
      setBusy(true);
      try {
        const published = await sessionRef.current!.publishPreview(command.directory, command.port);
        setPreview(published);
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: `${published.takeoverUrl ? "可人工接管的浏览器预览" : "临时应用"}已发布：${published.url}\n到期：${published.expiresAt}` }]);
        await refreshAccountUsage(false);
      } catch (error) {
        setStatus(`预览发布失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "takeover") {
      setBusy(true);
      try {
        const current = await sessionRef.current!.createBrowserTakeover();
        setPreview(current);
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: `浏览器已打开预览；人工接管：${current.takeoverUrl}` }]);
        await refreshAccountUsage(false);
      } catch (error) {
        setStatus(`人工接管创建失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "stopPreview") {
      setBusy(true);
      try {
        await sessionRef.current!.stopPreview();
        setPreview(undefined);
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: "临时预览和浏览器接管已停止" }]);
        await refreshAccountUsage(false);
      } catch (error) {
        setStatus(`停止预览失败：${errorText(error)}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "shutdownAll") {
      setBusy(true);
      setStatus("正在归档当前会话并关闭账户全部 RUNNING 沙盒…");
      appendProcess("已确认全账户停机操作");
      const current = sessionRef.current;
      try {
        const archivePath = await current?.archive();
        const result = await accountServiceRef.current!.shutdownAllRunning();
        await current?.close("reset");
        sessionRef.current = makeSession();
        setSandboxState("destroyed");
        setPreview(undefined);
        const summary = result.failures.length
          ? `全量停机部分完成：${result.deleted}/${result.attempted} 已关闭，${result.failures.length} 个失败`
          : `全量停机完成：${result.deleted}/${result.attempted} 个 RUNNING 沙盒已关闭`;
        setStatus(summary);
        appendProcess(summary);
        setMessages((items) => [...items, { id: nextId.current++, role: "system", text: `${summary}${archivePath ? `；会话已保存：${archivePath}` : ""}。下一次提问或 /new 才会创建新沙盒。` }]);
        try {
          const snapshot = await accountServiceRef.current!.snapshot({ includeMetrics: false });
          setAccountUsage(snapshot);
          setAccountError("");
        } catch (error) {
          setAccountError(errorText(error));
        }
      } catch (error) {
        const text = `全量停机失败：${errorText(error)}`;
        setStatus(text);
        appendProcess(text);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (command.type === "help") {
      setMessages((items) => [...items, { id: nextId.current++, role: "system", text: "/preview <目录> 发布临时前端 · /takeover 人工接管浏览器 · /stop-preview 停止 · /sandboxes 远端并行 · /bill 消费 · /shutdown-all SHUTDOWN ALL 全停 · /new 新建 · /resume <JSONL> 恢复 · /exit 保存销毁" }]);
      return;
    }

    const prompt = command.text;
    const assistantId = nextId.current++;
    setProcessSteps([{ id: nextProcessId.current++, text: "请求已进入 Agent 执行队列" }]);
    setMessages((items) => [
      ...items,
      { id: nextId.current++, role: "user", text: prompt },
      { id: assistantId, role: "assistant", text: "" },
    ]);
    setBusy(true);
    setStatus("GPT-5.6 正在响应…");

    try {
      for await (const event of sessionRef.current!.send(prompt)) {
        if (event.type === "text") {
          setMessages((items) => items.map((item) => item.id === assistantId
            ? { ...item, text: item.text + event.text }
            : item));
        } else {
          setStatus(event.text);
          appendProcess(event.text);
        }
      }
    } catch (error) {
      const text = `错误：${errorText(error)}`;
      setMessages((items) => items.map((item) => item.id === assistantId ? { ...item, text } : item));
      setStatus(text);
      appendProcess(text);
    } finally {
      setPreview(sessionRef.current?.preview);
      setBusy(false);
    }
  }, [appendProcess, busy, makeSession, onSandboxStatus, quit, refreshAccountUsage, refreshBillSpend, start]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1}>
        <Box flexDirection="column" flexGrow={1}>
          <Text bold color="cyan">◆ AGENTBAY / CLOUD AGENT CONSOLE</Text>
          <Text dimColor>隔离执行 · 会话可救援 · 官方消费可见</Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text bold color={sandboxState === "ready" ? "green" : sandboxState === "error" ? "red" : sandboxState === "destroyed" ? "gray" : "yellow"}>
            {sandboxState === "ready" ? "● LIVE" : sandboxState === "error" ? "● ERROR" : sandboxState === "destroyed" ? "○ STOPPED" : "● STARTING"}
          </Text>
          <Text dimColor>{MODEL} · {EFFORT} · process visible</Text>
        </Box>
      </Box>

      <Box marginTop={1} paddingX={1} justifyContent="space-between">
        <Text color={sandboxState === "ready" ? "green" : sandboxState === "error" ? "red" : "yellow"}>▸ {status}</Text>
        <Text dimColor>reasoning={REASONING}</Text>
      </Box>

      <Box flexDirection="column" borderStyle="single" borderColor={accountUsage && accountUsage.running >= accountUsage.parallelLimit ? "red" : "blue"} paddingX={1} marginTop={1}>
        <Box justifyContent="space-between">
          <Text bold color="blue">▣ REMOTE CAPACITY</Text>
          {accountUsage && <Text bold color={accountUsage.running >= accountUsage.parallelLimit ? "red" : "cyan"}>{accountUsage.running}/{accountUsage.parallelLimit} RUNNING · {accountUsage.utilizationPercent}%</Text>}
        </Box>
        {accountUsage ? (
          <>
            {accountUsage.sessions.map((session) => (
              <Text key={session.sessionId}>
                <Text color="green">● </Text><Text>{session.sessionId}</Text><Text dimColor> · {session.imageId || "unknown"}</Text>
                {session.estimatedCnyPerHour === undefined
                  ? <Text color="yellow"> · 指标暂不可用</Text>
                  : <Text dimColor> · {session.cpuCount}C/{session.memoryGiB}GiB · ¥{session.estimatedCnyPerHour.toFixed(2)}–{session.estimatedCnyPerHourHigh!.toFixed(2)}/h</Text>}
              </Text>
            ))}
            {!accountUsage.sessions.length && <Text dimColor>○ 当前账户没有 RUNNING 沙盒</Text>}
            <Text dimColor>Basic · 估算覆盖 {accountUsage.estimatedSessionCount}/{accountUsage.running}；官方已入账消费见底部状态行</Text>
          </>
        ) : <Text dimColor>◌ 正在从远端账户盘点会话…</Text>}
        {accountError && <Text color="red">× 盘点失败：{accountError}</Text>}
      </Box>

      {preview && (
        <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginTop={1}>
          <Text bold color="green">▣ TEMPORARY APP PREVIEW</Text>
          <Text><Text color="cyan">{preview.takeoverUrl === preview.url ? "BROWSER  " : "APP      "}</Text>{preview.url}</Text>
          {preview.takeoverUrl && preview.takeoverUrl !== preview.url && <Text><Text color="magenta">TAKEOVER </Text>{preview.takeoverUrl}</Text>}
          <Text dimColor>{preview.directory} · :{preview.port} · 到期 {new Date(preview.expiresAt).toLocaleString("zh-CN")}</Text>
          <Text dimColor>/takeover 创建浏览器 · /stop-preview 停止并回收</Text>
        </Box>
      )}

      {processSteps.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="magenta" paddingX={1} marginTop={1}>
          <Box justifyContent="space-between">
            <Text bold color="magenta">◇ EXECUTION TRACE</Text>
            <Text dimColor>可审计事件 · 不暴露隐藏思维</Text>
          </Box>
          {processSteps.map((step, index) => {
            const active = busy && index === processSteps.length - 1;
            return <Text key={step.id} color={active ? "cyan" : "green"}>{active ? "◆" : "✓"} {step.text}</Text>;
          })}
        </Box>
      )}

      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
        <Text bold dimColor>CONVERSATION</Text>
        {messages.slice(-10).map((message) => {
          const label = message.role === "user" ? "YOU" : message.role === "assistant" ? "AGENT" : "NOTE";
          const color = message.role === "user" ? "cyan" : message.role === "assistant" ? "green" : "yellow";
          return (
            <Box key={message.id} marginBottom={message.role === "system" ? 0 : 1}>
              <Text><Text bold color={color}>{label.padEnd(5)} </Text><Text>{message.text || (busy ? "…" : "")}</Text></Text>
            </Box>
          );
        })}
      </Box>

      <Box borderStyle="round" borderColor={busy ? "yellow" : "cyan"} paddingX={1} marginTop={1}>
        <Text bold color={busy ? "yellow" : "cyan"}>{busy ? "WAIT " : "ASK  "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={(value) => void submit(value)} focus={!busy} placeholder={busy ? "Agent 正在执行…" : "输入问题或 /help"} />
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Text color={billError ? "red" : billSpend ? "green" : "yellow"}>￥ {formatBillStatusLine(billSpend, billLoading, billError)}</Text>
        <Text dimColor>Esc 中止 · Ctrl+C 安全退出</Text>
      </Box>
      <Text dimColor>  /preview &lt;目录&gt; 发布 · /takeover 接管 · /stop-preview 停止 · /sandboxes 刷新 · /bill 消费 · /new · /resume</Text>
    </Box>
  );
}

async function smoke(): Promise<void> {
  const session = createAgentChatSession(({ state, detail }) => console.log(`[sandbox:${state}] ${detail}`));
  let answer = "";
  try {
    await session.start();
    for await (const event of session.send("必须调用 AgentBay bash 执行 printf AGENTBAY_HELLO，然后只回复命令的真实输出。")) {
      if (event.type === "text") answer += event.text;
      else console.log(`[sdk] ${event.text}`);
    }
    if (!answer.includes("AGENTBAY_HELLO")) throw new Error(`Smoke 未得到远程输出：${answer}`);
    console.log(`SMOKE_PASS ${answer.trim()}`);
  } finally {
    await session.close();
  }
}

async function rescueSmoke(): Promise<void> {
  const rescueCode = `RESCUE_${Date.now()}`;
  const first = createAgentChatSession(({ state, detail }) => console.log(`[first:${state}] ${detail}`));
  let archivePath: string | undefined;
  try {
    await first.start();
    for await (const event of first.send(`请记住救援口令 ${rescueCode}，只回复 STORED。`)) {
      if (event.type !== "text") console.log(`[first-sdk] ${event.text}`);
    }
    archivePath = (await archiveAndDestroy({ archive: () => first.archive(), destroy: () => first.close() })).archivePath;
  } catch (error) {
    await first.close();
    throw error;
  }
  if (!archivePath) throw new Error("首个会话没有生成外部 JSONL");

  const rescued = await rescueAgentChatSession(archivePath, ({ state, detail }) => console.log(`[rescued:${state}] ${detail}`));
  let answer = "";
  try {
    await rescued.session.start();
    for await (const event of rescued.session.send("刚才让我记住的救援口令是什么？只回复口令。")) {
      if (event.type === "text") answer += event.text;
      else console.log(`[rescued-sdk] ${event.text}`);
    }
    if (!answer.includes(rescueCode)) throw new Error(`恢复后未找回上下文：${answer}`);
    console.log(`RESCUE_PASS ${archivePath}`);
  } finally {
    await rescued.session.close();
  }
}

async function accountSmoke(): Promise<void> {
  const snapshot = await createAccountUsageService().snapshot();
  console.log(`ACCOUNT_PASS running=${snapshot.running}/${snapshot.parallelLimit} estimated_cny_per_hour=${snapshot.estimatedCnyPerHour.toFixed(2)}-${snapshot.estimatedCnyPerHourHigh.toFixed(2)} metrics=${snapshot.estimatedSessionCount}/${snapshot.running}`);
  const bill = await createAliyunBillExporter().export();
  console.log(`BILL_SPEND_PASS cycle=${bill.cycle} gross_cny=${bill.totalPretaxGrossAmount.toFixed(2)} charged_cny=${bill.totalPretaxAmount.toFixed(2)} path=${bill.path}`);
}

if (process.argv.includes("--smoke")) {
  await smoke();
} else if (process.argv.includes("--rescue-smoke")) {
  await rescueSmoke();
} else if (process.argv.includes("--account-smoke")) {
  await accountSmoke();
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("请在 TTY/Herdr 中运行 Ink TUI；自动验证请用 npm run smoke。");
  await render(<App />).waitUntilExit();
}
