import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function safeProcessValue(value: unknown): string {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 120);
}

export function describeSdkProcessMessage(message: SDKMessage, tools: Map<string, string>): string[] {
  const raw = object(message);
  if (message.type === "assistant") {
    return message.message.content.flatMap((rawBlock): string[] => {
      const block = object(rawBlock);
      if (block.type !== "tool_use") return [];
      const name = String(block.name || "tool").replace("mcp__agentbay__", "AgentBay/");
      const id = String(block.id || "");
      if (id) tools.set(id, name);
      const input = object(block.input);
      const action = name.endsWith("/read_file") ? `读取 ${safeProcessValue(input.path)}`
        : name.endsWith("/write_file") ? `写入 ${safeProcessValue(input.path)}`
          : name.endsWith("/publish_preview") ? "发布临时前端预览"
            : name.endsWith("/browser_takeover") ? "创建人工接管浏览器"
              : name.endsWith("/stop_preview") ? "停止临时预览"
                : "执行远程命令";
      return [`${name} · ${action}`];
    });
  }
  if (message.type === "user") {
    const content = object(raw.message).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((rawBlock): string[] => {
      const block = object(rawBlock);
      if (block.type !== "tool_result") return [];
      const name = tools.get(String(block.tool_use_id || "")) || "AgentBay/tool";
      return [`${name} · ${block.is_error ? "失败" : "完成"}`];
    });
  }
  if (raw.type === "system" && raw.subtype === "api_retry") {
    return [`模型请求重试 ${raw.attempt}/${raw.max_retries} · ${(Number(raw.retry_delay_ms || 0) / 1_000).toFixed(1)}s`];
  }
  return [];
}
