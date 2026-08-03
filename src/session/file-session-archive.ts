import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import type { SessionArchivePort, SessionEntry, SessionKey } from "./application.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function assertSessionId(sessionId: string): void {
  if (!isClaudeSessionId(sessionId)) throw new Error("无效的 Claude sessionId");
}

function safeSubpath(subpath: string): string {
  if (subpath.startsWith("/") || subpath.split("/").some((part) => !part || part === "." || part === ".." || !/^[\w.-]+$/u.test(part))) {
    throw new Error("无效的会话 subpath");
  }
  return subpath;
}

async function readEntries(path: string, missingAsNull: true): Promise<SessionEntry[] | null>;
async function readEntries(path: string, missingAsNull?: false): Promise<SessionEntry[]>;
async function readEntries(path: string, missingAsNull = false): Promise<SessionEntry[] | null> {
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("外部会话路径不是文件");
    if (info.size > MAX_ARCHIVE_BYTES) throw new Error("外部会话文件超过 100 MiB 限制");
    text = await readFile(path, "utf8");
  } catch (error) {
    if (missingAsNull && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  const entries: SessionEntry[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || typeof (entry as { type?: unknown }).type !== "string") throw new Error();
      entries.push(entry as SessionEntry);
    } catch {
      throw new Error(`无效的 Claude JSONL（第 ${index + 1} 行）`);
    }
  }
  return entries;
}

function sessionIdFrom(entries: SessionEntry[], path: string): string {
  for (const entry of entries) {
    const candidate = typeof entry.sessionId === "string"
      ? entry.sessionId
      : typeof entry.session_id === "string" ? entry.session_id : undefined;
    if (isClaudeSessionId(candidate)) return candidate;
  }
  const filename = path.slice(path.lastIndexOf("/") + 1, -extname(path).length);
  if (isClaudeSessionId(filename)) return filename;
  throw new Error("外部 JSONL 中找不到 Claude sessionId");
}

export class FileSessionArchive implements SessionArchivePort {
  private readonly root: string;
  private readonly boundFiles: Map<string, string>;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(root = process.env.AGENTBAY_SESSION_DIR || "/tmp/agentbay-demo-sessions", boundFiles = new Map<string, string>()) {
    this.root = resolve(root);
    this.boundFiles = boundFiles;
  }

  static async resumeFromId(
    sessionId: string,
    root = process.env.AGENTBAY_SESSION_DIR || "/tmp/agentbay-demo-sessions",
  ): Promise<{ archive: FileSessionArchive; sessionId: string; path: string }> {
    assertSessionId(sessionId);
    return this.resumeFrom(join(resolve(root), `${sessionId}.jsonl`));
  }

  static async resumeFrom(reference: string): Promise<{ archive: FileSessionArchive; sessionId: string; path: string }> {
    const path = resolve(reference);
    const entries = await readEntries(path);
    if (!entries.length) throw new Error("外部 Claude JSONL 为空");
    const sessionId = sessionIdFrom(entries, path);
    const archive = new FileSessionArchive(dirname(path), new Map([[sessionId, path]]));
    return { archive, sessionId, path };
  }

  pathFor(sessionId: string, subpath?: string): string {
    assertSessionId(sessionId);
    if (!subpath) return this.boundFiles.get(sessionId) || join(this.root, `${sessionId}.jsonl`);
    return join(this.root, sessionId, `${safeSubpath(subpath)}.jsonl`);
  }

  async append(key: SessionKey, entries: SessionEntry[]): Promise<void> {
    if (!entries.length) return;
    const path = this.pathFor(key.sessionId, key.subpath);
    await this.serial(path, async () => {
      const existing = await readEntries(path, true) || [];
      const uuids = new Set(existing.flatMap((entry) => entry.uuid ? [entry.uuid] : []));
      const additions = entries.filter((entry) => !entry.uuid || !uuids.has(entry.uuid) && Boolean(uuids.add(entry.uuid)));
      if (!additions.length) return;

      const payload = `${[...existing, ...additions].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      try {
        // ponytail: atomic O(n) rewrite is ideal for demo-sized chats; use chunk files/object storage when transcripts become large.
        await writeFile(temporary, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }

  async load(key: SessionKey): Promise<SessionEntry[] | null> {
    const path = this.pathFor(key.sessionId, key.subpath);
    await this.queues.get(path);
    return readEntries(path, true);
  }

  async confirm(sessionId: string): Promise<string> {
    const path = this.pathFor(sessionId);
    const entries = await this.load({ projectKey: "", sessionId });
    if (!entries?.length) throw new Error("Claude 会话尚未写入外部存储，已取消销毁");
    return path;
  }

  private async serial(path: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(path) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(path, current);
    try {
      await current;
    } finally {
      if (this.queues.get(path) === current) this.queues.delete(path);
    }
  }
}
