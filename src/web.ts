import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AccountUsageSnapshot,
	ShutdownAllResult,
} from "./account/application.js";
import {
	formatBillStatusLine,
	type AgentBaySpendSnapshot,
} from "./account/aliyun-billing.js";
import type { AgentChatSession } from "./agent.js";
import {
	createAccountUsageService,
	createAgentChatSession,
	createAliyunBillExporter,
	rescueAgentChatSessionById,
} from "./composition.js";
import { safeMessage, type SandboxStatus } from "./sandbox.js";
import { archiveAndDestroy } from "./session/application.js";
import { parseSessionCommand } from "./session/commands.js";
import { isClaudeSessionId } from "./session/file-session-archive.js";
import {
	createWebRequestHandler,
	freshWebConversation,
	type WebExecutionTrace,
	type WebMessage,
	type WebRuntimePort,
} from "./web-http.js";

function sessionIdFromArchive(path?: string): string | undefined {
	if (!path) return undefined;
	const sessionId = basename(path, ".jsonl");
	return isClaudeSessionId(sessionId) ? sessionId : undefined;
}

class SharedWebRuntime implements WebRuntimePort {
	private session: AgentChatSession;
	private readonly account = createAccountUsageService();
	private readonly spend = createAliyunBillExporter();
	private messages: WebMessage[] = [
		{
			id: 0,
			role: "system",
			text: "这是一个可信 LAN 共享会话；前端任务会生成临时预览，可按需人工接管浏览器。",
		},
	];
	private nextId = 1;
	private nextProcessId = 1;
	private busy = true;
	private status = "正在启动独立 AgentBay 沙盒…";
	private sandboxState = "new";
	private accountUsage?: AccountUsageSnapshot;
	private accountError = "";
	private billSpend?: AgentBaySpendSnapshot;
	private billError = "";
	private billLoading = true;
	private timer?: NodeJS.Timeout;

	constructor() {
		this.session = this.makeSession();
	}

	private onSandboxStatus = (value: SandboxStatus): void => {
		this.sandboxState = value.state;
		this.status = value.detail;
	};

	private makeSession(): AgentChatSession {
		return createAgentChatSession(this.onSandboxStatus);
	}

	private note(text: string): void {
		this.messages = [
			...this.messages.slice(-49),
			{ id: this.nextId++, role: "system", text },
		];
	}

	private appendTrace(messageId: number, text: string): void {
		this.messages = this.messages.map((message) => {
			if (
				message.id !== messageId ||
				message.role !== "assistant" ||
				!message.trace
			)
				return message;
			if (message.trace.steps.at(-1)?.text === text) return message;
			return {
				...message,
				trace: {
					...message.trace,
					steps: [
						...message.trace.steps.slice(-7),
						{ id: this.nextProcessId++, text },
					],
				},
			};
		});
	}

	private finishTrace(
		messageId: number,
		status: WebExecutionTrace["status"],
		durationMs: number,
	): void {
		this.messages = this.messages.map((message) =>
			message.id === messageId && message.trace
				? { ...message, trace: { ...message.trace, status, durationMs } }
				: message,
		);
	}

	private async refreshAccount(
		includeMetrics = true,
		detectExternalShutdown = false,
	): Promise<void> {
		try {
			this.accountUsage = await this.account.snapshot({ includeMetrics });
			this.accountError = "";
			const currentId = this.session.sandboxSessionId;
			if (
				detectExternalShutdown &&
				currentId &&
				!this.accountUsage.sessions.some(
					(session) => session.sessionId === currentId,
				)
			) {
				await this.session.close("reset");
				this.session = this.makeSession();
				this.sandboxState = "destroyed";
				this.status =
					"当前沙盒已从其他入口关闭；下一次提问或 /new 将创建新沙盒";
				this.note("检测到当前沙盒已被另一入口关闭");
			}
		} catch (error) {
			this.accountError = safeMessage(error);
		}
	}

	private async refreshSpend(): Promise<void> {
		this.billLoading = true;
		try {
			this.billSpend = await this.spend.export();
			this.billError = "";
		} catch (error) {
			this.billError = safeMessage(error);
		} finally {
			this.billLoading = false;
		}
	}

	async start(): Promise<void> {
		try {
			await this.session.start();
		} catch (error) {
			this.status = safeMessage(error);
			this.sandboxState = "error";
		}
		await Promise.all([this.refreshAccount(), this.refreshSpend()]);
		this.busy = false;
		this.timer = setInterval(() => {
			if (!this.busy) void this.refreshAccount(false, true);
		}, 30_000);
		this.timer.unref();
	}

	snapshot(): { [key: string]: unknown; busy: boolean } {
		return {
			accountError: this.accountError,
			accountUsage: this.accountUsage,
			billStatus: formatBillStatusLine(
				this.billSpend,
				this.billLoading,
				this.billError,
			),
			busy: this.busy,
			messages: this.messages,
			preview: this.session.preview,
			sandboxState: this.sandboxState,
			status: this.status,
			updatedAt: new Date().toISOString(),
		};
	}

	abort(): void {
		this.session.abort();
		this.status = "正在中止当前请求…";
	}

	async resume(sessionId: string): Promise<{ sessionId: string }> {
		if (this.busy) throw new Error("Agent 正在执行，不能恢复会话");
		this.busy = true;
		this.status = `正在恢复 Claude 会话 ${sessionId}…`;
		let rescued:
			| Awaited<ReturnType<typeof rescueAgentChatSessionById>>
			| undefined;
		try {
			rescued = await rescueAgentChatSessionById(
				sessionId,
				this.onSandboxStatus,
			);
			const current = this.session;
			await archiveAndDestroy({
				archive: () => current.archive(),
				destroy: () => current.close("reset"),
			});
			this.session = rescued.session;
			this.note(
				`已恢复 Claude 会话 ${rescued.sessionId}；正在创建新的独立沙盒`,
			);
			await this.session.start();
			await this.refreshAccount();
			return { sessionId: rescued.sessionId };
		} catch (error) {
			if (rescued && this.session !== rescued.session)
				await rescued.session.close("reset");
			const notFound = (error as NodeJS.ErrnoException).code === "ENOENT";
			this.status = `恢复失败：${notFound ? "找不到该会话归档" : safeMessage(error)}`;
			throw Object.assign(
				new Error(notFound ? "找不到该会话归档" : safeMessage(error)),
				{ statusCode: notFound ? 404 : 500 },
			);
		} finally {
			this.busy = false;
		}
	}

	async exitCurrent(): Promise<{ archived: boolean; sessionId?: string }> {
		if (this.busy) throw new Error("Agent 正在执行，不能退出共享会话");
		this.busy = true;
		this.status = "正在归档并退出当前 Web 会话…";
		const current = this.session;
		try {
			const result = await archiveAndDestroy({
				archive: () => current.archive(),
				destroy: () => current.close(),
			});
			this.session = this.makeSession();
			this.sandboxState = "destroyed";
			this.status = "当前 Web 会话已安全退出；服务保持在线";
			const sessionId = sessionIdFromArchive(result.archivePath);
			this.note(
				sessionId
					? `当前会话已归档并退出；恢复 ID：${sessionId}`
					: "当前会话已退出（尚无聊天记录）",
			);
			await this.refreshAccount(false);
			return {
				archived: Boolean(result.archivePath),
				...(sessionId ? { sessionId } : {}),
			};
		} catch (error) {
			this.status = `退出失败：${safeMessage(error)}`;
			throw error;
		} finally {
			this.busy = false;
		}
	}

	async shutdownAll(): Promise<ShutdownAllResult> {
		if (this.busy) throw new Error("Agent 正在执行，不能关闭全部沙盒");
		this.busy = true;
		this.status = "正在归档共享会话并关闭账户全部 RUNNING 沙盒…";
		const current = this.session;
		try {
			const archivePath = await current.archive();
			const result = await this.account.shutdownAllRunning();
			await current.close("reset");
			this.session = this.makeSession();
			this.sandboxState = "destroyed";
			this.status = result.failures.length
				? `全量停机部分完成：${result.deleted}/${result.attempted} 已关闭，${result.failures.length} 个失败`
				: `全量停机完成：${result.deleted}/${result.attempted} 个 RUNNING 沙盒已关闭`;
			const archivedId = sessionIdFromArchive(archivePath);
			this.note(
				`${this.status}${archivedId ? `；共享会话恢复 ID：${archivedId}` : ""}。发送新问题或 /new 时才会创建新沙盒。`,
			);
			await this.refreshAccount(false);
			return result;
		} catch (error) {
			this.status = `全量停机失败：${safeMessage(error)}`;
			throw error;
		} finally {
			this.busy = false;
		}
	}

	async submit(raw: string): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const command = parseSessionCommand(raw);
		let activeAssistantId: number | undefined;
		let startedAt = 0;
		try {
			if (command.type === "new") {
				const previous = this.session;
				const archived = await archiveAndDestroy({
					archive: () => previous.archive(),
					destroy: () => previous.close("reset"),
				});
				this.session = this.makeSession();
				const archivedId = sessionIdFromArchive(archived.archivePath);
				this.messages = freshWebConversation(
					this.nextId++,
					archivedId
						? `旧会话已保存；恢复 ID：${archivedId}`
						: "正在创建全新共享会话",
				);
				await this.session.start();
				await this.refreshAccount();
				return;
			}
			if (command.type === "sandboxes") {
				await this.refreshAccount(true, true);
				this.note("远端沙盒清单与规格已刷新");
				return;
			}
			if (command.type === "bill") {
				await this.refreshSpend();
				this.note(formatBillStatusLine(this.billSpend, false, this.billError));
				return;
			}
			if (command.type === "preview") {
				const preview = await this.session.publishPreview(
					command.directory,
					command.port,
				);
				this.note(
					preview.takeoverUrl
						? `Basic 端口映射受限，已发布可人工接管的浏览器预览：${preview.url}\n到期：${preview.expiresAt}`
						: `临时应用已发布：${preview.url}\n到期：${preview.expiresAt}；使用 /takeover 创建可人工接管的浏览器。`,
				);
				await this.refreshAccount(false);
				return;
			}
			if (command.type === "takeover") {
				const preview = await this.session.createBrowserTakeover();
				this.note(`浏览器已打开预览；人工接管：${preview.takeoverUrl}`);
				await this.refreshAccount(false);
				return;
			}
			if (command.type === "stopPreview") {
				await this.session.stopPreview();
				this.note("临时预览和浏览器接管已停止");
				await this.refreshAccount(false);
				return;
			}
			if (command.type === "shutdownAll") {
				this.note("请使用页面右上角“关闭全部沙盒”按钮，并再次精确输入确认短语");
				return;
			}
			if (command.type === "help") {
				this.note(
					"全部命令：/help · /new · /sandboxes (/sessions) · /bill · /preview <目录> [30100–30199] · /takeover · /stop-preview · /resume <session-id> (/rescue) · /exit (/quit) · /shutdown-all SHUTDOWN ALL",
				);
				return;
			}
			if (command.type === "resume") {
				this.note(
					"Web 恢复只接受 Claude sessionId；请从命令面板填写，不能传入宿主机路径",
				);
				return;
			}
			if (command.type === "exit") {
				this.note(
					"请使用命令面板的 /exit；浏览器会在安全归档后尝试关闭当前窗口",
				);
				return;
			}
			if (command.type === "error") {
				this.note(command.message);
				return;
			}

			const assistantId = this.nextId++;
			activeAssistantId = assistantId;
			startedAt = Date.now();
			this.messages = [
				...this.messages.slice(-48),
				{ id: this.nextId++, role: "user", text: command.text },
				{
					id: assistantId,
					role: "assistant",
					text: "",
					trace: {
						steps: [
							{ id: this.nextProcessId++, text: "请求已进入 Agent 执行队列" },
						],
						status: "running",
					},
				},
			];
			this.status = "Agent 正在执行…";
			for await (const event of this.session.send(command.text)) {
				if (event.type === "text") {
					this.messages = this.messages.map((message) =>
						message.id === assistantId
							? { ...message, text: message.text + event.text }
							: message,
					);
				} else {
					this.status = event.text;
					this.appendTrace(assistantId, event.text);
				}
			}
			this.finishTrace(assistantId, "complete", Date.now() - startedAt);
		} catch (error) {
			const text = `错误：${safeMessage(error)}`;
			this.status = text;
			if (activeAssistantId === undefined) this.note(text);
			else {
				this.messages = this.messages.map((message) =>
					message.id === activeAssistantId ? { ...message, text } : message,
				);
				this.appendTrace(activeAssistantId, text);
				this.finishTrace(
					activeAssistantId,
					"error",
					startedAt ? Date.now() - startedAt : 0,
				);
			}
		} finally {
			this.busy = false;
		}
	}

	async close(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		await archiveAndDestroy({
			archive: () => this.session.archive(),
			destroy: () => this.session.close(),
		});
	}
}

function lanAddress(): string {
	const entries = Object.entries(networkInterfaces());
	const ordered = [
		...entries.filter(([name]) => name === "en0"),
		...entries.filter(([name]) => name !== "en0"),
	];
	for (const [, addresses] of ordered) {
		const found = addresses?.find(
			(address) => address.family === "IPv4" && !address.internal,
		);
		if (found) return found.address;
	}
	return "127.0.0.1";
}

async function main(): Promise<void> {
	const host = process.env.AGENTBAY_WEB_HOST || lanAddress();
	const port = Number(process.env.AGENTBAY_WEB_PORT || 8787);
	if (!Number.isInteger(port) || port < 1 || port > 65_535)
		throw new Error("AGENTBAY_WEB_PORT 无效");
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const html = await readFile(resolve(root, "web/index.html"), "utf8");
	const runtime = new SharedWebRuntime();
	const server = createServer(createWebRequestHandler(runtime, html));
	server.headersTimeout = 10_000;
	server.requestTimeout = 30_000;
	await new Promise<void>((resolveListen, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolveListen);
	});

	console.log(`WEB_READY http://${host}:${port} · trusted LAN, no login`);
	void runtime.start();

	let stopping = false;
	const stop = async () => {
		if (stopping) return;
		stopping = true;
		const closed = new Promise<void>((resolveClose) =>
			server.close(() => resolveClose()),
		);
		server.closeAllConnections();
		await closed;
		await runtime.close().catch(() => undefined);
	};
	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	process.once("SIGHUP", () => void stop());
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) await main();
