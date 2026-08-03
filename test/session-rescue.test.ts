import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseSessionCommand } from "../src/session/commands.js";
import { archiveAndDestroy } from "../src/session/application.js";
import { FileSessionArchive } from "../src/session/file-session-archive.js";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "agentbay-rescue-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("文件适配器保存 Claude JSONL、按 uuid 去重并使用私有权限", async () => {
  await withTempDir(async (directory) => {
    const archive = new FileSessionArchive(directory);
    const key = { projectKey: "project", sessionId: SESSION_ID };
    const message = { type: "user", uuid: "message-1", sessionId: SESSION_ID, message: { content: "hello" } };
    const marker = { type: "mode", mode: "default" };

    await archive.append(key, [message, marker]);
    await archive.append(key, [message, marker]);

    assert.deepEqual(await archive.load(key), [message, marker, marker]);
    const path = archive.pathFor(SESSION_ID);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 3);
  });
});

test("Web 只能按 UUID 从配置的归档根目录恢复会话", async () => {
  await withTempDir(async (directory) => {
    const archive = new FileSessionArchive(directory);
    await archive.append({ projectKey: "web", sessionId: SESSION_ID }, [{ type: "user", sessionId: SESSION_ID }]);

    const resumed = await FileSessionArchive.resumeFromId(SESSION_ID, directory);
    assert.equal(resumed.sessionId, SESSION_ID);
    assert.equal(resumed.path, join(directory, `${SESSION_ID}.jsonl`));
    await assert.rejects(FileSessionArchive.resumeFromId("../../etc/passwd", directory), /sessionId/);
  });
});

test("重命名后的外部 JSONL 仍可解析 sessionId、恢复并继续追加", async () => {
  await withTempDir(async (directory) => {
    const original = new FileSessionArchive(directory);
    const key = { projectKey: "first-host", sessionId: SESSION_ID };
    const first = { type: "user", uuid: "first", sessionId: SESSION_ID };
    await original.append(key, [first]);

    const rescuedPath = join(directory, "saved chat.jsonl");
    await rename(original.pathFor(SESSION_ID), rescuedPath);
    const rescued = await FileSessionArchive.resumeFrom(rescuedPath);
    const second = { type: "assistant", uuid: "second", sessionId: SESSION_ID };

    assert.equal(rescued.sessionId, SESSION_ID);
    assert.equal(rescued.path, rescuedPath);
    assert.deepEqual(await rescued.archive.load({ projectKey: "other-host", sessionId: SESSION_ID }), [first]);
    await rescued.archive.append({ projectKey: "other-host", sessionId: SESSION_ID }, [second]);
    assert.deepEqual(await rescued.archive.load({ projectKey: "other-host", sessionId: SESSION_ID }), [first, second]);
  });
});

test("文件适配器拒绝不安全的 subpath 和损坏的恢复文件", async () => {
  await withTempDir(async (directory) => {
    const archive = new FileSessionArchive(directory);
    await assert.rejects(
      archive.append({ projectKey: "project", sessionId: SESSION_ID, subpath: "../escape" }, [{ type: "user" }]),
      /subpath/,
    );
    const broken = join(directory, "broken.jsonl");
    await writeFile(broken, "not-json\n", { mode: 0o600 });
    await assert.rejects(FileSessionArchive.resumeFrom(broken), /JSONL/);
  });
});

test("退出用例严格先确认归档，再销毁沙盒", async () => {
  const events: string[] = [];
  const result = await archiveAndDestroy({
    archive: async () => { events.push("archive"); return "/tmp/chat.jsonl"; },
    destroy: async () => { events.push("destroy"); },
  });

  assert.deepEqual(events, ["archive", "destroy"]);
  assert.equal(result.archivePath, "/tmp/chat.jsonl");

  const failedEvents: string[] = [];
  await assert.rejects(archiveAndDestroy({
    archive: async () => { failedEvents.push("archive"); throw new Error("save failed"); },
    destroy: async () => { failedEvents.push("destroy"); },
  }), /save failed/);
  assert.deepEqual(failedEvents, ["archive"]);
});

test("TUI 命令支持 /exit、/quit、/resume 和 /rescue", () => {
  assert.deepEqual(parseSessionCommand("/exit"), { type: "exit" });
  assert.deepEqual(parseSessionCommand("/quit"), { type: "exit" });
  assert.deepEqual(parseSessionCommand("/resume /tmp/saved chat.jsonl"), { type: "resume", path: "/tmp/saved chat.jsonl" });
  assert.deepEqual(parseSessionCommand("/rescue /tmp/chat.jsonl"), { type: "resume", path: "/tmp/chat.jsonl" });
  assert.deepEqual(parseSessionCommand("/resume"), { type: "error", message: "用法：/resume <外部 JSONL 文件>" });
  assert.deepEqual(parseSessionCommand("/sandboxes"), { type: "sandboxes" });
  assert.deepEqual(parseSessionCommand("/sessions"), { type: "sandboxes" });
  assert.deepEqual(parseSessionCommand("/bill"), { type: "bill" });
  assert.deepEqual(parseSessionCommand("/shutdown-all"), { type: "error", message: "危险操作：输入 /shutdown-all SHUTDOWN ALL 确认关闭账户全部 RUNNING 沙盒" });
  assert.deepEqual(parseSessionCommand("/shutdown-all SHUTDOWN ALL"), { type: "shutdownAll" });
  assert.deepEqual(parseSessionCommand("hello"), { type: "prompt", text: "hello" });
});
