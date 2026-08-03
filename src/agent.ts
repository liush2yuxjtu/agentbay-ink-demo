import { rm } from "node:fs/promises";
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { describeSdkProcessMessage } from "./agent-process.js";
import { PreviewApplication, type PreviewState } from "./preview/application.js";
import { EphemeralSandbox, safeMessage } from "./sandbox.js";
import type { SessionArchivePort } from "./session/application.js";

export const MODEL = "gpt-5.6-luna";
export const EFFORT = "low" as const;
export const REASONING = "disabled" as const;

export type ChatEvent =
  | { type: "status"; text: string }
  | { type: "text"; text: string }
  | { type: "done"; text: string };

const MCP_TOOLS = [
  "mcp__agentbay__bash",
  "mcp__agentbay__read_file",
  "mcp__agentbay__write_file",
  "mcp__agentbay__publish_preview",
  "mcp__agentbay__browser_takeover",
  "mcp__agentbay__stop_preview",
];

function messageOf(error: unknown): string {
  return safeMessage(error);
}

function result(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function safeSdkEnv(configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "HOME", "TMPDIR", "USER", "SHELL", "LANG", "LC_ALL", "TERM",
    "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "NO_PROXY", "no_proxy",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "agentbay-ink-demo/0.1.0";
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

function previewText(preview: PreviewState): string {
  return [
    `${preview.takeoverUrl === preview.url ? "BROWSER_PREVIEW_READY" : "PREVIEW_READY"} ${preview.url}`,
    `目录：${preview.directory} · 端口：${preview.port} · 到期：${preview.expiresAt}`,
    ...(preview.takeoverUrl && preview.takeoverUrl !== preview.url ? [`TAKEOVER_READY ${preview.takeoverUrl}`] : []),
  ].join("\n");
}

function mcpServer(sandbox: EphemeralSandbox, previews: PreviewApplication) {
  const call = async (fn: () => Promise<string>) => {
    try {
      return result(await fn());
    } catch (error) {
      return result(messageOf(error), true);
    }
  };

  return createSdkMcpServer({
    name: "agentbay",
    version: "0.1.0",
    instructions: "所有代码、Shell 和文件操作都必须在本会话独享的阿里云 AgentBay 沙盒中执行。",
    alwaysLoad: true,
    tools: [
      tool(
        "bash",
        "在本会话独享的阿里云 AgentBay Linux 沙盒中执行命令。不要用于宿主机操作。",
        {
          command: z.string().min(1).max(4_000),
          timeout_seconds: z.number().int().min(1).max(90).default(60),
        },
        ({ command, timeout_seconds }) => call(() => sandbox.execute(command, timeout_seconds * 1_000)),
      ),
      tool(
        "read_file",
        "读取 AgentBay 沙盒内的 UTF-8 文本文件。",
        { path: z.string().min(1).max(1_000) },
        ({ path }) => call(() => sandbox.readFile(path)),
      ),
      tool(
        "write_file",
        "写入 AgentBay 沙盒内的 UTF-8 文本文件；父目录不存在时由 AgentBay 创建。",
        {
          path: z.string().min(1).max(1_000),
          content: z.string().max(100_000),
        },
        ({ path, content }) => call(() => sandbox.writeFile(path, content)),
      ),
      tool(
        "publish_preview",
        "将已完成的静态前端目录发布为外部可访问的临时链接。目录必须包含 index.html，且位于 /tmp 或 /home/wuying。",
        {
          directory: z.string().min(1).max(512),
          port: z.number().int().min(30100).max(30199).default(30100),
        },
        ({ directory, port }) => call(async () => previewText(await previews.publish({ directory, port }))),
      ),
      tool(
        "browser_takeover",
        "为当前前端预览创建 AgentBay 浏览器沙盒，默认打开应用并返回人工接管链接。仅在用户要求浏览器测试或人工接管时调用。",
        {},
        () => call(async () => previewText(await previews.takeover())),
      ),
      tool(
        "stop_preview",
        "停止当前临时前端预览和浏览器接管会话。",
        {},
        () => call(async () => { await previews.stop(); return "PREVIEW_STOPPED"; }),
      ),
    ],
  });
}

function options(
  sandbox: EphemeralSandbox,
  archive: SessionArchivePort,
  configDir: string,
  abortController: AbortController,
  previews: PreviewApplication,
  sessionId?: string,
): Options {
  return {
    abortController,
    canUseTool: async (name) => MCP_TOOLS.includes(name)
      ? { behavior: "allow" }
      : { behavior: "deny", message: "只允许使用本会话的 AgentBay 远程沙盒工具。" },
    cwd: process.cwd(),
    effort: EFFORT,
    env: safeSdkEnv(configDir),
    includePartialMessages: true,
    loadTimeoutMs: 10_000,
    maxTurns: 8,
    mcpServers: { agentbay: mcpServer(sandbox, previews) },
    model: MODEL,
    permissionMode: "default",
    persistSession: true,
    sessionStore: archive,
    sessionStoreFlush: "batched",
    settingSources: [],
    strictMcpConfig: true,
    systemPrompt: [
      "你是一个简洁的中文 Cloud Agent SDK Demo。",
      "需要运行代码、命令或读写文件时，只能使用 AgentBay MCP 工具；它们连接到当前对话独享的远程阿里云沙盒。",
      "不要声称访问了宿主机，不要索要或输出任何密钥。先做最小可验证操作，再报告真实结果。",
      "当用户要求开发可视化前端 App 时，完成并验证 index.html 后必须调用 publish_preview，返回真正可打开的临时链接，不要只报告沙盒文件路径。",
      "只有用户要求浏览器测试或人工接管时才调用 browser_takeover；接管和预览链接都属于临时访问凭据。",
    ].join("\n"),
    thinking: { type: "disabled" },
    tools: [],
    ...(sessionId ? { resume: sessionId } : {}),
  };
}

export class AgentChatSession {
  private readonly sandbox: EphemeralSandbox;
  private readonly archiveStore: SessionArchivePort;
  private readonly previews: PreviewApplication;
  private readonly runtimeConfigDir: string;
  private sdkSessionId?: string;
  private abortController?: AbortController;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(options: {
    sandbox: EphemeralSandbox;
    archive: SessionArchivePort;
    runtimeConfigDir: string;
    resumeSessionId?: string;
  }) {
    this.sandbox = options.sandbox;
    this.archiveStore = options.archive;
    this.previews = new PreviewApplication(options.sandbox);
    this.runtimeConfigDir = options.runtimeConfigDir;
    this.sdkSessionId = options.resumeSessionId;
  }

  get sandboxSessionId(): string | undefined {
    return this.sandbox.sessionId;
  }

  get preview(): PreviewState | undefined {
    return this.previews.current();
  }

  publishPreview(directory?: string, port?: number): Promise<PreviewState> {
    return this.previews.publish({ directory, port });
  }

  createBrowserTakeover(): Promise<PreviewState> {
    return this.previews.takeover();
  }

  stopPreview(): Promise<void> {
    return this.previews.stop();
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("会话已关闭");
    await this.sandbox.start();
  }

  async *send(prompt: string): AsyncGenerator<ChatEvent> {
    if (this.closed) throw new Error("会话已关闭，请使用 /new");
    if (this.abortController) throw new Error("上一条请求仍在执行");
    await this.start();

    const abortController = new AbortController();
    this.abortController = abortController;
    let streamed = false;
    let completed = false;
    let answering = false;
    const activeTools = new Map<string, string>();

    try {
      yield { type: "status", text: "正在分析请求并规划可验证步骤" };
      for await (const message of query({
        prompt,
        options: options(this.sandbox, this.archiveStore, this.runtimeConfigDir, abortController, this.previews, this.sdkSessionId),
      })) {
        this.sandbox.touch();
        if (message.type === "system" && message.subtype === "mirror_error") {
          throw new Error(`外部会话归档失败：${message.error}`);
        }
        if (message.type === "system" && message.subtype === "init") {
          this.sdkSessionId = message.session_id;
          yield { type: "status", text: "Claude Agent SDK 已连接 · AgentBay MCP 已加载" };
          continue;
        }

        for (const step of describeSdkProcessMessage(message, activeTools)) {
          yield { type: "status", text: step };
        }

        if (message.type === "stream_event") {
          const event = message.event;
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            if (!answering) {
              answering = true;
              yield { type: "status", text: "正在整理最终答复" };
            }
            streamed = true;
            yield { type: "text", text: event.delta.text };
          }
        } else if (message.type === "result") {
          if (message.subtype !== "success") throw new Error(`${message.subtype}: ${message.errors.join("; ")}`);
          if (!streamed && message.result) yield { type: "text", text: message.result };
          completed = true;
          yield {
            type: "done",
            text: `${message.num_turns} turn · ${(message.duration_ms / 1_000).toFixed(1)}s`,
          };
        }
      }
      if (!completed) throw new Error("Claude Agent SDK 未返回完成结果");
      const archivePath = await this.archive();
      if (archivePath) yield { type: "status", text: `会话已保存：${archivePath}` };
    } finally {
      this.abortController = undefined;
      this.sandbox.touch();
    }
  }

  abort(): void {
    this.abortController?.abort();
  }

  async archive(): Promise<string | undefined> {
    return this.sdkSessionId ? this.archiveStore.confirm(this.sdkSessionId) : undefined;
  }

  async close(reason: "closed" | "reset" = "closed"): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.abort();
    this.closePromise = (async () => {
      try {
        await this.sandbox.destroy(reason);
      } finally {
        await rm(this.runtimeConfigDir, { recursive: true, force: true });
      }
    })();
    return this.closePromise;
  }
}
