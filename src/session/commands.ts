import { SHUTDOWN_ALL_CONFIRMATION } from "../account/application.js";
import { DEFAULT_PREVIEW_DIRECTORY, DEFAULT_PREVIEW_PORT, MAX_PREVIEW_PORT, MIN_PREVIEW_PORT } from "../preview/application.js";

export type SessionCommand =
  | { type: "exit" }
  | { type: "new" }
  | { type: "help" }
  | { type: "sandboxes" }
  | { type: "bill" }
  | { type: "preview"; directory: string; port: number }
  | { type: "takeover" }
  | { type: "stopPreview" }
  | { type: "shutdownAll" }
  | { type: "resume"; path: string }
  | { type: "error"; message: string }
  | { type: "prompt"; text: string };

function unquote(path: string): string {
  const first = path[0];
  return path.length >= 2 && (first === '"' || first === "'") && path.at(-1) === first
    ? path.slice(1, -1)
    : path;
}

export function parseSessionCommand(raw: string): SessionCommand {
  const text = raw.trim();
  if (text === "/exit" || text === "/quit") return { type: "exit" };
  if (text === "/new") return { type: "new" };
  if (text === "/help") return { type: "help" };
  if (text === "/sandboxes" || text === "/sessions") return { type: "sandboxes" };
  if (text === "/bill") return { type: "bill" };
  if (text === "/takeover") return { type: "takeover" };
  if (text === "/stop-preview") return { type: "stopPreview" };
  const preview = text.match(/^\/preview(?:\s+(\S+))?(?:\s+(\S+))?$/u);
  if (preview) {
    const directory = unquote(preview[1] || DEFAULT_PREVIEW_DIRECTORY);
    const port = preview[2] === undefined ? DEFAULT_PREVIEW_PORT : Number(preview[2]);
    return Number.isInteger(port) && port >= MIN_PREVIEW_PORT && port <= MAX_PREVIEW_PORT
      ? { type: "preview", directory, port }
      : { type: "error", message: `用法：/preview <沙盒目录> [${MIN_PREVIEW_PORT}–${MAX_PREVIEW_PORT}]` };
  }
  if (text.startsWith("/preview")) return { type: "error", message: `用法：/preview <沙盒目录> [${MIN_PREVIEW_PORT}–${MAX_PREVIEW_PORT}]` };
  if (text === `/shutdown-all ${SHUTDOWN_ALL_CONFIRMATION}`) return { type: "shutdownAll" };
  if (text.startsWith("/shutdown-all")) {
    return { type: "error", message: `危险操作：输入 /shutdown-all ${SHUTDOWN_ALL_CONFIRMATION} 确认关闭账户全部 RUNNING 沙盒` };
  }

  const match = text.match(/^\/(?:resume|rescue)(?:\s+(.*))?$/u);
  if (match) {
    const path = unquote((match[1] || "").trim());
    return path
      ? { type: "resume", path }
      : { type: "error", message: "用法：/resume <外部 JSONL 文件>" };
  }
  return { type: "prompt", text };
}
