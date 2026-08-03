# LAN WebApp、Slash 命令、会话恢复与执行轨迹：TDD 证据

## 目标

提供可信局域网可直接打开的共享 WebApp，展示全部 slash 命令、新手指引和可审计执行过程，并支持安全 resume、exit 与账户级停机。

## 当前边界

- **无分享令牌 / 无登录**：直接打开 `http://192.168.26.153:8787/`；不再生成 `/tmp/agentbay-demo-web-url`。
- **可信 LAN**：默认只绑定当前机器私有 LAN IPv4，而不是所有网卡；没有 TLS，不得映射公网。
- **一个共享会话**：所有同网段访问者看到并控制同一 Web 会话。
- **执行过程，不是隐藏思维**：保持 `thinking/reasoning=disabled`；展示规划标签、SDK/MCP、工具调用/完成、turn 时长与归档。
- **Node 标准库优先**：`node:http` + 单静态 HTML；没有新增依赖、构建器或 Web 框架。

## RED → GREEN

| 行为 | RED | GREEN |
|---|---|---|
| 无 token 直连 | 基础 URL 返回 401“需要有效的 LAN 分享令牌” | `/` 与 `/api/state` 直接 HTTP 200；无 Cookie、无 token 文件 |
| Web resume | `FileSessionArchive.resumeFromId is not a function`；API 404 | 仅 UUID、固定归档根目录、无宿主机任意路径；真实上下文恢复通过 |
| Web exit | API 404 | 归档 → 销毁当前沙盒 → 返回恢复 ID → 尝试 `window.close()`；受浏览器限制时显示回退页 |
| Slash 能力面板 | 页面没有完整命令参考 | `/help`、`/new`、`/sandboxes`/`/sessions`、`/bill`、`/resume`/`/rescue`、`/exit`/`/quit`、`/shutdown-all` 全部可见并可填入 |
| 新手指引 | 无 onboarding | 首次访问自动打开可访问原生 dialog；顶部按钮可随时重看 |
| LAN 全量停机 | API 404 | `SHUTDOWN ALL` 二次确认；错误短语 400、忙碌 409、成功 200 |
| 新会话清屏 | `/new` 只追加 NOTE，刷新后旧聊天仍显示 | 归档和销毁成功后，以唯一的新会话 NOTE 替换消息列表；旧记录不再进入快照 |

## 写请求保护

移除身份认证后仍保留最小浏览器安全边界：

- 所有 POST 必须是 `application/json`，普通跨站表单无法触发。
- `Sec-Fetch-Site: cross-site` 或 Origin host 不一致时返回 403。
- 无 CORS；CSP nonce；`frame-ancestors 'none'`；`X-Content-Type-Options: nosniff`；`Referrer-Policy: no-referrer`。
- 消息限制 1–4000 字符，请求体限制 16 KiB；生命周期操作在 Agent 忙碌时返回 409。
- `/shutdown-all` 仍要求精确短语并明确影响整个 AgentBay 账户。
- 模型只拥有六个 AgentBay MCP 工具：bash、读/写文件、发布预览、浏览器接管、停止预览；没有宿主机工具。

这些控制不等于身份认证：任何可信 LAN 用户都拥有共享会话控制权。

## Resume / Exit 语义

- Web `/resume <session-id>` 与 `/rescue <session-id>` 只接受 Claude UUID。
- 后端固定解析为 `AGENTBAY_SESSION_DIR/<UUID>.jsonl`；`../../etc/passwd` 等路径输入返回 400。
- `/new` 会在归档和销毁成功后清空旧显示，只保留包含恢复 ID 的新会话 NOTE；不显示宿主机绝对归档路径。
- `/exit` 和全量停机后的 NOTE 会显示恢复 ID，不显示宿主机绝对归档路径。
- `/exit` 先确认 JSONL 归档，再销毁当前 Web 沙盒；Web 服务本身保持在线。
- 浏览器通常禁止脚本关闭手动打开的标签页；此时页面切换到“已安全退出”回退界面并展示恢复 ID，用户可手动关窗或重新打开控制台。

## 真实验收

- 截图中的基础地址现在直接返回控制台：`BASE_HTTP=200`、`TOKENLESS_LAN_PASS`。
- `/tmp/agentbay-demo-web-url` 已删除且不再生成。
- Web exit：`WEB_EXIT_API_PASS archived=true session_id=validated`。
- Web resume：返回 ID 与 exit ID 一致，并创建新沙盒。
- 恢复后询问旧口令，得到完整 `WEB_RESUME_GUIDE_*`：`WEB_RESUME_CONTEXT_PASS marker=matched`。
- 既有执行轨迹验收：`WEB_TRACE_OK`、`PROCESS_TRACE_OK`。
- 全量停机三入口验收仍通过：LAN、CLI、TUI 均为 2/2 删除。
- 新会话清屏 RED：`SyntaxError: ... does not provide an export named 'freshWebConversation'`。
- 新会话清屏 GREEN：`新建会话会清空页面中的旧聊天记录` 通过；真实 runtime 返回 `WEB_NEW_CONVERSATION_E2E_PASS messages=1 old_history=false sandbox=ready`。

## 自动验证

- `npm run check`：类型检查、23/23 测试、构建通过。
- `npm run test:coverage`：行 92.83%、分支 80.38%、函数 87.96%。
- `npm audit --audit-level=high`：0 vulnerabilities。
- Web 静态页面：完整命令面板、原生 guide dialog、exit 回退页、唯一 ID、内联脚本语法均通过。

## 运行

```bash
npm run web
# 或后台 Herdr tab
HERDR_WORKSPACE_ID=<workspace-id> npm run web:herdr

open http://192.168.26.153:8787/
```

## 已知边界

- 无账号、RBAC 或消息级审计；只适合同一可信 LAN。
- LAN HTTP 没有传输加密；公网部署必须增加 HTTPS 身份代理、RBAC、审计与限流。
- 页面使用 750ms 只读轮询；只有并发规模证明不足时才换 SSE/WebSocket。
