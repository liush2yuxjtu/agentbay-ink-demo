import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { createWebRequestHandler, freshWebConversation } from "../src/web-http.js";


test("LAN Web 无分享令牌即可访问，并保护同源写请求", async () => {
  const submitted: string[] = [];
  let aborted = false;
  let shutdowns = 0;
  let runtimeBusy = false;
  const resumed: string[] = [];
  let exits = 0;
  const runtime = {
    snapshot: () => ({ busy: runtimeBusy, status: "ready", messages: [] }),
    submit: async (text: string) => { submitted.push(text); },
    abort: () => { aborted = true; },
    shutdownAll: async () => { shutdowns++; return { attempted: 2, deleted: 2, failures: [] }; },
    resume: async (sessionId: string) => { resumed.push(sessionId); return { sessionId }; },
    exitCurrent: async () => { exits++; return { archived: true, sessionId: "123e4567-e89b-42d3-a456-426614174000" }; },
  };
  const html = "<!doctype html><html><body>agentBayDemo · /Users/liushiyuwin/projects/agentBayDemo · 019fc543-1e19-7728-a9f1-7a3aa077c0ce<script nonce=\"__CSP_NONCE__\"></script></body></html>";
  const server = createServer(createWebRequestHandler(runtime, html));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const jsonHeaders = { "content-type": "application/json" };

  try {
    assert.equal((await fetch(`${origin}/health`)).status, 200);

    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.has("set-cookie"), false);
    assert.match(page.headers.get("content-security-policy") || "", /script-src 'nonce-/);
    assert.equal(page.headers.has("cross-origin-opener-policy"), false);
    const pageText = await page.text();
    assert.match(pageText, /agentBayDemo/);
    assert.equal(pageText.includes("__CSP_NONCE__"), false);

    const state = await fetch(`${origin}/api/state`);
    assert.equal(state.status, 200);
    assert.equal((await state.json() as { status: string }).status, "ready");

    const crossSite = await fetch(`${origin}/api/exit`, {
      method: "POST",
      headers: { ...jsonHeaders, "sec-fetch-site": "cross-site" },
      body: "{}",
    });
    assert.equal(crossSite.status, 403);
    assert.equal(exits, 0);

    const sent = await fetch(`${origin}/api/message`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(sent.status, 202);
    assert.deepEqual(submitted, ["hello"]);

    const empty = await fetch(`${origin}/api/message`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ message: "" }),
    });
    assert.equal(empty.status, 400);

    const abort = await fetch(`${origin}/api/abort`, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(abort.status, 202);
    assert.equal(aborted, true);

    const rejectedShutdown = await fetch(`${origin}/api/shutdown-all`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ confirmation: "yes" }),
    });
    assert.equal(rejectedShutdown.status, 400);
    assert.equal(shutdowns, 0);

    const shutdown = await fetch(`${origin}/api/shutdown-all`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ confirmation: "SHUTDOWN ALL" }),
    });
    assert.equal(shutdown.status, 200);
    assert.deepEqual(await shutdown.json(), { attempted: 2, deleted: 2, failures: [] });
    assert.equal(shutdowns, 1);

    const invalidResume = await fetch(`${origin}/api/resume`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId: "../../etc/passwd" }),
    });
    assert.equal(invalidResume.status, 400);
    assert.deepEqual(resumed, []);

    const resume = await fetch(`${origin}/api/resume`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId: "123e4567-e89b-42d3-a456-426614174000" }),
    });
    assert.equal(resume.status, 200);
    assert.deepEqual(await resume.json(), { sessionId: "123e4567-e89b-42d3-a456-426614174000" });
    assert.deepEqual(resumed, ["123e4567-e89b-42d3-a456-426614174000"]);

    const exit = await fetch(`${origin}/api/exit`, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(exit.status, 200);
    assert.deepEqual(await exit.json(), { archived: true, sessionId: "123e4567-e89b-42d3-a456-426614174000" });
    assert.equal(exits, 1);

    runtimeBusy = true;
    const busyShutdown = await fetch(`${origin}/api/shutdown-all`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ confirmation: "SHUTDOWN ALL" }),
    });
    assert.equal(busyShutdown.status, 409);
    assert.equal(shutdowns, 1);
    const busyResume = await fetch(`${origin}/api/resume`, {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ sessionId: "123e4567-e89b-42d3-a456-426614174000" }),
    });
    assert.equal(busyResume.status, 409);
    const busyExit = await fetch(`${origin}/api/exit`, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(busyExit.status, 409);
    assert.equal(exits, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("新建会话会清空页面中的旧聊天记录", () => {
  assert.deepEqual(freshWebConversation(7, "已创建全新共享会话"), [
    { id: 7, role: "system", text: "已创建全新共享会话" },
  ]);
});

test("Web 页面展示完整 slash 命令、临时预览、人工接管、新手指引与关闭回退", async () => {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  for (const command of ["/help", "/new", "/sandboxes", "/sessions", "/bill", "/preview", "/takeover", "/stop-preview", "/resume", "/rescue", "/exit", "/quit", "/shutdown-all"]) {
    assert.match(html, new RegExp(`<code>${command.replace("/", "\\/")}`));
  }
  assert.match(html, /id="preview-card"/);
  assert.match(html, /id="preview-open"/);
  assert.match(html, /id="takeover-open"/);
  assert.match(html, /id="preview-feedback"/);
  assert.match(html, /<dialog[^>]+id="guide-dialog"/);
  assert.match(html, /id="guide-open"/);
  assert.match(html, /id="closed-screen"/);
  assert.match(html, /data-testid="agent-root" data-agent-state="running"/);
  assert.match(html, /data-testid="agent-prompt"/);
  assert.match(html, /data-testid="agent-send"/);
  assert.match(html, /data-testid="agent-conversation"/);
});
