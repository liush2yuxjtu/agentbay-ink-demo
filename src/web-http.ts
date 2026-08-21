import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	SHUTDOWN_ALL_CONFIRMATION,
	type ShutdownAllResult,
} from "./account/application.js";
import { safeMessage } from "./sandbox.js";
import { isClaudeSessionId } from "./session/file-session-archive.js";

export type WebTraceStep = { id: number; text: string };
export type WebExecutionTrace = {
	steps: WebTraceStep[];
	status: "running" | "complete" | "error";
	durationMs?: number;
};
export type WebMessage = {
	id: number;
	role: "user" | "assistant" | "system";
	text: string;
	trace?: WebExecutionTrace;
};

export function freshWebConversation(id: number, text: string): WebMessage[] {
	return [{ id, role: "system", text }];
}

export interface WebRuntimePort {
	snapshot(): { busy?: boolean; [key: string]: unknown };
	submit(message: string): Promise<void>;
	abort(): void;
	shutdownAll(): Promise<ShutdownAllResult>;
	resume(sessionId: string): Promise<{ sessionId: string }>;
	exitCurrent(): Promise<{ archived: boolean; sessionId?: string }>;
}

function securityHeaders(nonce?: string): Record<string, string> {
	return {
		"cache-control": "no-store",
		"content-security-policy": `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; style-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; connect-src 'self'; img-src 'self' data:`,
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff",
		"x-frame-options": "DENY",
	};
}

function send(
	response: ServerResponse,
	status: number,
	body: string,
	type = "text/plain; charset=utf-8",
	nonce?: string,
): void {
	response.writeHead(status, {
		...securityHeaders(nonce),
		"content-type": type,
	});
	response.end(body);
}

function json(response: ServerResponse, status: number, value: unknown): void {
	send(
		response,
		status,
		`${JSON.stringify(value)}\n`,
		"application/json; charset=utf-8",
	);
}

function isCrossSite(request: IncomingMessage): boolean {
	if (request.headers["sec-fetch-site"] === "cross-site") return true;
	const origin = request.headers.origin;
	if (!origin) return false;
	try {
		return new URL(origin).host !== request.headers.host;
	} catch {
		return true;
	}
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.from(chunk);
		size += buffer.length;
		if (size > 16_384)
			throw Object.assign(new Error("请求内容过大"), { statusCode: 413 });
		chunks.push(buffer);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw Object.assign(new Error("JSON 格式无效"), { statusCode: 400 });
	}
}

export function createWebRequestHandler(
	runtime: WebRuntimePort,
	htmlTemplate: string,
) {
	return async (
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> => {
		try {
			const url = new URL(request.url || "/", "http://lan.local");
			if (request.method === "GET" && url.pathname === "/health")
				return json(response, 200, { ok: true });
			if (request.method === "POST" && isCrossSite(request))
				return json(response, 403, { error: "拒绝跨站写请求" });
			if (
				request.method === "POST" &&
				!request.headers["content-type"]?.startsWith("application/json")
			) {
				return json(response, 415, {
					error: "写请求必须使用 application/json",
				});
			}

			if (request.method === "GET" && url.pathname === "/") {
				const nonce = randomBytes(18).toString("base64url");
				return send(
					response,
					200,
					htmlTemplate.replaceAll("__CSP_NONCE__", nonce),
					"text/html; charset=utf-8",
					nonce,
				);
			}
			if (request.method === "GET" && url.pathname === "/api/state")
				return json(response, 200, runtime.snapshot());
			if (request.method === "POST" && url.pathname === "/api/abort") {
				runtime.abort();
				return json(response, 202, { accepted: true });
			}
			if (request.method === "POST" && url.pathname === "/api/resume") {
				if (runtime.snapshot().busy)
					return json(response, 409, { error: "Agent 正在执行，不能恢复会话" });
				const body = (await readJsonBody(request)) as { sessionId?: unknown };
				if (!isClaudeSessionId(body.sessionId))
					return json(response, 400, {
						error: "必须提供有效的 Claude sessionId",
					});
				return json(response, 200, await runtime.resume(body.sessionId));
			}
			if (request.method === "POST" && url.pathname === "/api/exit") {
				if (runtime.snapshot().busy)
					return json(response, 409, {
						error: "Agent 正在执行，不能退出共享会话",
					});
				return json(response, 200, await runtime.exitCurrent());
			}
			if (request.method === "POST" && url.pathname === "/api/shutdown-all") {
				if (runtime.snapshot().busy)
					return json(response, 409, {
						error: "Agent 正在执行，不能关闭全部沙盒",
					});
				const body = (await readJsonBody(request)) as {
					confirmation?: unknown;
				};
				if (body.confirmation !== SHUTDOWN_ALL_CONFIRMATION) {
					return json(response, 400, {
						error: `必须精确输入 ${SHUTDOWN_ALL_CONFIRMATION}`,
					});
				}
				return json(response, 200, await runtime.shutdownAll());
			}
			if (request.method === "POST" && url.pathname === "/api/message") {
				if (runtime.snapshot().busy)
					return json(response, 409, { error: "Agent 正在执行上一条请求" });
				const body = (await readJsonBody(request)) as { message?: unknown };
				const message =
					typeof body.message === "string" ? body.message.trim() : "";
				if (!message || message.length > 4_000)
					return json(response, 400, { error: "消息长度必须为 1–4000 字符" });
				void runtime.submit(message).catch(() => undefined);
				return json(response, 202, { accepted: true });
			}
			return json(response, 404, { error: "Not found" });
		} catch (error) {
			const status = Number(
				(error as { statusCode?: number }).statusCode || 500,
			);
			return json(response, status, {
				error: status === 500 ? "服务器内部错误" : safeMessage(error),
			});
		}
	};
}
