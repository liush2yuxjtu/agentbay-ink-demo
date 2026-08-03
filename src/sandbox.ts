import { AgentBay, LifecyclePolicy, setupLogger } from "wuying-agentbay-sdk";
import type { PreviewRuntimePort, PreviewState, ValidatedPreviewInput } from "./preview/application.js";

setupLogger({ level: "ERROR", enableConsole: false, logFile: "" });

export type SandboxState = "new" | "starting" | "ready" | "destroying" | "destroyed" | "error";
export type SandboxStatus = { state: SandboxState; detail: string };

type Operation = { success: boolean; errorMessage?: string };
type SessionLike = {
  sessionId: string;
  command: {
    executeCommand(command: string, timeoutMs?: number): Promise<Operation & { output: string; exitCode?: number }>;
  };
  fileSystem: {
    readFile(path: string): Promise<Operation & { content: string }>;
    writeFile(path: string, content: string): Promise<Operation>;
  };
  getLink?(protocolType?: string, port?: number): Promise<Operation & { data?: unknown }>;
  browser?: {
    initializeAsync(options: Record<string, unknown>): Promise<boolean>;
    destroy(): Promise<void>;
  };
  info?(): Promise<Operation & { data?: { resourceUrl?: string } }>;
  delete(syncContext?: boolean): Promise<Operation>;
};
type CreateSandbox = () => Promise<SessionLike>;

const DEFAULT_IDLE_MS = 10 * 60_000;
const DEFAULT_PREVIEW_TTL_MS = 60 * 60_000;
const MAX_OUTPUT = 12_000;

export function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(?:sk|akm?)-[A-Za-z0-9_-]{8,}\b/gu, "<redacted>")
    .replace(/\b(?:s-[a-z0-9]+|link-\d+-\d+|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/giu, "<redacted-id>")
    .replace(/\btenantId\s*[:=]\s*[A-Za-z0-9-]+/giu, "tenantId: <redacted>")
    .replace(/(api[_ -]?key|token|secret)\s*[:=]\s*\S+/giu, "$1=<redacted>");
}

function clipped(text: string): string {
  return text.length <= MAX_OUTPUT ? text : `${text.slice(0, MAX_OUTPUT)}\n…（输出已截断）`;
}

function requireApiKey(): void {
  if (!process.env.AGENTBAY_API_KEY?.trim()) {
    throw new Error("缺少 AGENTBAY_API_KEY；请写入 ~/.config/agentbay/api_key 后重试");
  }
}

async function createRemoteSandbox(idleMs: number, previewTtlMs: number): Promise<SessionLike> {
  requireApiKey();
  const idleMinutes = Math.max(3, Math.ceil(Math.max(idleMs, previewTtlMs) / 60_000));
  const result = await new AgentBay().create({
    imageId: "browser_latest",
    labels: { app: "agentbay-ink-demo", lifecycle: "ephemeral" },
    lifecyclePolicy: new LifecyclePolicy({ idleReleaseTimeout: idleMinutes, maxRuntime: 120 }),
  });
  if (!result.success || !result.session) {
    throw new Error(`AgentBay 沙盒创建失败：${result.errorMessage || "未知错误"}`);
  }
  return result.session;
}

function validHttpUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}未返回有效 URL`);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`${label}协议无效`);
  return url.toString();
}

export class EphemeralSandbox implements PreviewRuntimePort {
  private readonly idleMs: number;
  private readonly previewTtlMs: number;
  private readonly createSandbox: CreateSandbox;
  private readonly onStatus?: (status: SandboxStatus) => void;
  private session?: SessionLike;
  private browserInitialized = false;
  private preview?: PreviewState;
  private previewPid?: string;
  private startPromise?: Promise<void>;
  private destroyPromise?: Promise<void>;
  private idleTimer?: NodeJS.Timeout;
  private previewTimer?: NodeJS.Timeout;
  private currentState: SandboxState = "new";

  constructor(options: {
    idleMs?: number;
    previewTtlMs?: number;
    createSandbox?: CreateSandbox;
    onStatus?: (status: SandboxStatus) => void;
  } = {}) {
    this.idleMs = options.idleMs ?? Number(process.env.AGENTBAY_IDLE_MS || DEFAULT_IDLE_MS);
    this.previewTtlMs = options.previewTtlMs ?? Number(process.env.AGENTBAY_PREVIEW_TTL_MS || DEFAULT_PREVIEW_TTL_MS);
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) throw new Error("AGENTBAY_IDLE_MS 必须是正数");
    if (!Number.isFinite(this.previewTtlMs) || this.previewTtlMs <= 0) throw new Error("AGENTBAY_PREVIEW_TTL_MS 必须是正数");
    this.createSandbox = options.createSandbox ?? (() => createRemoteSandbox(this.idleMs, this.previewTtlMs));
    this.onStatus = options.onStatus;
  }

  get state(): SandboxState {
    return this.currentState;
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  async start(): Promise<void> {
    if (this.currentState === "ready") return this.touch();
    if (this.startPromise) return this.startPromise;
    if (this.currentState === "destroyed" || this.currentState === "destroying") {
      throw new Error("该会话沙盒已销毁，请使用 /new 创建新会话");
    }

    this.startPromise = (async () => {
      this.setStatus("starting", "正在创建独立 AgentBay 沙盒…");
      try {
        this.session = await this.createSandbox();
        if (this.currentState === "destroying" || this.currentState === "destroyed") return;
        this.setStatus("ready", `AgentBay 已就绪 · ${Math.round(this.idleMs / 60_000)} 分钟无活动自动销毁`);
        this.touch();
      } catch (error) {
        this.setStatus("error", safeMessage(error));
        throw error;
      }
    })();
    return this.startPromise;
  }

  touch(): void {
    if (this.currentState !== "ready") return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.preview) return;
    this.idleTimer = setTimeout(() => void this.destroy("idle"), this.idleMs);
    this.idleTimer.unref();
  }

  async execute(command: string, timeoutMs = 60_000): Promise<string> {
    const session = await this.requireSession();
    this.touch();
    const result = await session.command.executeCommand(command, timeoutMs);
    this.touch();
    const output = clipped(result.output || result.errorMessage || "（无输出）");
    if (!result.success) throw new Error(`远程命令失败（exit ${result.exitCode ?? "?"}）：${safeMessage(output)}`);
    return output;
  }

  async readFile(path: string): Promise<string> {
    const session = await this.requireSession();
    this.touch();
    const result = await session.fileSystem.readFile(path);
    this.touch();
    if (!result.success) throw new Error(`远程文件读取失败：${safeMessage(result.errorMessage || path)}`);
    return clipped(result.content);
  }

  async writeFile(path: string, content: string): Promise<string> {
    const session = await this.requireSession();
    this.touch();
    const result = await session.fileSystem.writeFile(path, content);
    this.touch();
    if (!result.success) throw new Error(`远程文件写入失败：${safeMessage(result.errorMessage || path)}`);
    return `已写入 ${path}（${Buffer.byteLength(content)} bytes）`;
  }

  currentPreview(): PreviewState | undefined {
    return this.preview ? { ...this.preview } : undefined;
  }

  async publishPreview(input: ValidatedPreviewInput): Promise<PreviewState> {
    const session = await this.requireSession();
    if (!session.getLink) throw new Error("当前 AgentBay 沙盒不支持端口预览链接");
    if (this.preview) await this.stopPreview();

    const logPath = `/tmp/agentbay-preview-${input.port}.log`;
    const directory = `'${input.directory}'`;
    const start = await session.command.executeCommand(
      `test -d ${directory} && test -f ${directory}/index.html && test -z "$(find ${directory} -type l -print -quit)" && test -z "$(find ${directory} -type f \\( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' \\) -print -quit)" && test "$(du -sb ${directory} | cut -f1)" -le 20971520 && { nohup python3 -m http.server ${input.port} --bind 0.0.0.0 --directory ${directory} >${logPath} 2>&1 < /dev/null & echo $!; }`,
      10_000,
    );
    const pid = (start.output || "").trim().split(/\s+/u).at(-1) || "";
    if (!start.success || !/^\d+$/u.test(pid)) {
      throw new Error(`无法启动静态预览；目录须包含 index.html、无符号链接/密钥文件且不超过 20 MiB：${safeMessage(start.errorMessage || start.output)}`);
    }

    const health = await session.command.executeCommand(
      `python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:${input.port}/', timeout=5).read(1); print('PREVIEW_HEALTH_OK')"`,
      10_000,
    );
    if (!health.success || !health.output.includes("PREVIEW_HEALTH_OK")) {
      await session.command.executeCommand(`kill ${pid} 2>/dev/null || true`, 5_000);
      throw new Error(`预览服务健康检查失败：${safeMessage(health.errorMessage || health.output)}`);
    }

    let directUrl: string | undefined;
    let directError = "";
    try {
      const link = await session.getLink(undefined, input.port);
      if (!link.success) throw new Error(link.errorMessage || "未知错误");
      directUrl = validHttpUrl(link.data, "AgentBay 预览");
    } catch (error) {
      directError = safeMessage(error);
    }

    let takeoverUrl: string | undefined;
    if (!directUrl) {
      try {
        takeoverUrl = await this.openBrowser(`http://127.0.0.1:${input.port}`);
      } catch (error) {
        await session.command.executeCommand(`kill ${pid} 2>/dev/null || true`, 5_000);
        throw new Error(`端口预览不可用（${directError}）；浏览器回退也失败：${safeMessage(error)}`);
      }
    }

    this.previewPid = pid;
    this.preview = {
      ...input,
      url: directUrl || takeoverUrl!,
      ...(takeoverUrl ? { takeoverUrl } : {}),
      expiresAt: new Date(Date.now() + this.previewTtlMs).toISOString(),
    };
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.destroy("previewExpired"), this.previewTtlMs);
    this.previewTimer.unref();
    this.setStatus("ready", takeoverUrl
      ? "Basic 端口映射受限；已改用可人工接管的浏览器预览"
      : `临时预览已发布 · 端口 ${input.port} · 到期后自动销毁`);
    return { ...this.preview };
  }

  async createTakeover(): Promise<PreviewState> {
    if (!this.preview) throw new Error("请先使用 /preview 发布前端应用");
    if (this.preview.takeoverUrl) return { ...this.preview };
    const takeoverUrl = await this.openBrowser(this.preview.url);
    this.preview = { ...this.preview, takeoverUrl };
    this.setStatus("ready", "浏览器沙盒已打开预览；可以人工接管测试");
    return { ...this.preview };
  }

  private async openBrowser(url: string): Promise<string> {
    const session = await this.requireSession();
    if (!session.browser || !session.info) throw new Error("当前沙盒镜像不支持浏览器人工接管");
    const initialized = await session.browser.initializeAsync({ callForUser: true, defaultNavigateUrl: url });
    if (!initialized) throw new Error("AgentBay 浏览器初始化失败");
    this.browserInitialized = true;
    const info = await session.info();
    if (!info.success) throw new Error(info.errorMessage || "AgentBay 浏览器接管链接创建失败");
    return validHttpUrl(info.data?.resourceUrl, "AgentBay 浏览器接管");
  }

  async stopPreview(): Promise<void> {
    if (this.previewTimer) clearTimeout(this.previewTimer);
    this.previewTimer = undefined;
    const session = this.session;
    if (this.browserInitialized && session?.browser) await session.browser.destroy().catch(() => undefined);
    this.browserInitialized = false;
    const pid = this.previewPid;
    this.preview = undefined;
    this.previewPid = undefined;
    if (session && pid) await session.command.executeCommand(`kill ${pid} 2>/dev/null || true`, 5_000).catch(() => undefined);
    if (this.currentState === "ready") {
      this.setStatus("ready", "临时预览与人工接管已停止");
      this.touch();
    }
  }

  async destroy(reason: "idle" | "closed" | "reset" | "previewExpired" = "closed"): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    this.destroyPromise = (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.previewTimer) clearTimeout(this.previewTimer);
      this.setStatus("destroying", reason === "idle" ? "10 分钟无活动，正在销毁沙盒…" : reason === "previewExpired" ? "临时预览已到期，正在销毁沙盒…" : "正在销毁沙盒…");
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      this.browserInitialized = false;
      this.preview = undefined;
      this.previewPid = undefined;
      const session = this.session;
      this.session = undefined;
      if (session) {
        try {
          const result = await session.delete(false);
          if (!result.success) throw new Error(result.errorMessage || "AgentBay 删除失败");
        } catch (error) {
          this.setStatus("error", `沙盒清理失败：${safeMessage(error)}`);
          return;
        }
      }
      this.setStatus("destroyed", reason === "idle" ? "沙盒已因空闲销毁；输入 /new 继续" : reason === "previewExpired" ? "临时预览已到期并销毁；输入 /new 继续" : "沙盒已销毁");
    })();
    return this.destroyPromise;
  }

  private async requireSession(): Promise<SessionLike> {
    await this.start();
    if (!this.session) throw new Error("AgentBay 沙盒不可用");
    return this.session;
  }

  private setStatus(state: SandboxState, detail: string): void {
    this.currentState = state;
    this.onStatus?.({ state, detail });
  }
}
