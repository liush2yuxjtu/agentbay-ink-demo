import assert from "node:assert/strict";
import test from "node:test";
import { describeSdkProcessMessage } from "../src/agent-process.js";

test("SDK 消息转换为可展示、不会泄露隐藏思维的执行轨迹", () => {
  const tools = new Map<string, string>();

  assert.deepEqual(describeSdkProcessMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool-1", name: "mcp__agentbay__read_file", input: { path: "/tmp/demo.txt" } }] },
  } as never, tools), ["AgentBay/read_file · 读取 /tmp/demo.txt"]);

  assert.deepEqual(describeSdkProcessMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "secret output" }] },
  } as never, tools), ["AgentBay/read_file · 完成"]);

  assert.deepEqual(describeSdkProcessMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool-2", name: "mcp__agentbay__bash", input: { command: "echo should-not-be-rendered" } }] },
  } as never, tools), ["AgentBay/bash · 执行远程命令"]);

  assert.deepEqual(describeSdkProcessMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "tool-2", is_error: true, content: "private failure" }] },
  } as never, tools), ["AgentBay/bash · 失败"]);

  assert.deepEqual(describeSdkProcessMessage({
    type: "assistant",
    message: { content: [{ type: "text", text: "final" }, { type: "tool_use", id: "tool-3", name: "mcp__agentbay__write_file", input: { path: "/tmp/out\n.txt", content: "hidden" } }] },
  } as never, tools), ["AgentBay/write_file · 写入 /tmp/out .txt"]);

  assert.deepEqual(describeSdkProcessMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool-4", name: "mcp__agentbay__publish_preview", input: { directory: "/tmp/todo-app", port: 30100 } }] },
  } as never, tools), ["AgentBay/publish_preview · 发布临时前端预览"]);
  assert.deepEqual(describeSdkProcessMessage({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "tool-5", name: "mcp__agentbay__browser_takeover", input: {} }] },
  } as never, tools), ["AgentBay/browser_takeover · 创建人工接管浏览器"]);

  assert.deepEqual(describeSdkProcessMessage({ type: "user", message: { content: "plain text" } } as never, tools), []);
  assert.deepEqual(describeSdkProcessMessage({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "unknown", content: "ok" }] },
  } as never, tools), ["AgentBay/tool · 完成"]);

  assert.deepEqual(describeSdkProcessMessage({
    type: "system",
    subtype: "api_retry",
    attempt: 2,
    max_retries: 3,
    retry_delay_ms: 1000,
  } as never, tools), ["模型请求重试 2/3 · 1.0s"]);
  assert.deepEqual(describeSdkProcessMessage({ type: "system", subtype: "init" } as never, tools), []);
});
