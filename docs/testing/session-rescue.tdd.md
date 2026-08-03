# 会话归档、销毁与救援：TDD 证据

## 目标

支持 `/exit` 手动退出时先把 Claude Agent SDK/Claude Code JSONL 会话保存到外部空间（Demo 使用 `/tmp`），再销毁 AgentBay 沙盒和本地临时会话；支持进程重启后通过 `/resume <JSONL>` 或 `/rescue <JSONL>` 恢复对话上下文。

## 六边形边界

| 边界 | 实现 |
|---|---|
| 入站适配器 | Ink TUI：`src/index.tsx`；命令解析：`src/session/commands.ts` |
| 应用层 | `SessionArchivePort` 与 `archiveAndDestroy`：`src/session/application.ts` |
| 出站适配器 | 原子 JSONL 文件存储：`src/session/file-session-archive.ts` |
| 组合根 | `src/composition.ts` 注入文件归档、AgentBay 沙盒和临时 `CLAUDE_CONFIG_DIR` |

## RED → GREEN

| 行为 | RED 证据 | GREEN 证据 |
|---|---|---|
| 外部 JSONL 保存与加载 | `npm test -- --test-name-pattern=...` 返回 `ERR_MODULE_NOT_FOUND: src/session/commands.js` | 新增会话测试后 7/7 通过 |
| 先保存、后销毁 | 缺少应用用例模块 | 测试确认调用顺序为 `archive → destroy`；保存失败时不会销毁 |
| `/exit`、`/resume`、`/rescue` | 缺少命令解析模块 | 四种命令及缺参错误测试通过 |
| JSONL 安全边界 | 缺少文件适配器 | UUID 去重、损坏 JSONL、不安全 subpath、`0600` 权限测试通过 |

## 自动验证

- `npm run check`：类型检查通过；7/7 测试通过；构建通过。
- `npm run test:coverage`：行 87.01%，分支 80.54%，函数 85.71%。
- `npm audit --audit-level=high`：0 vulnerabilities。
- `npm run smoke`：`SMOKE_PASS AGENTBAY_HELLO`，并确认会话 JSONL 已写入外部目录。
- `npm run rescue:smoke`：首会话保存 → 首沙盒销毁 → 新沙盒创建 → 从同一外部 JSONL 恢复唯一口令 → `RESCUE_PASS` → 新沙盒销毁。

## Herdr 真实交互验证

1. 在当前第 2 个 Herdr tab 输入唯一手工标记，TUI 显示会话已保存到 `/tmp/agentbay-demo-sessions/<session-id>.jsonl`。
2. 输入 `/exit` 后回到 shell；归档文件仍存在且权限为 `0600`。
3. 销毁后确认运行沙盒数为 `0`，本地 `agentbay-demo-runtime-*` 会话目录为 `0`。
4. 在同一 tab 重启 TUI，输入 `/resume <上述 JSONL>`；系统创建新的 AgentBay 沙盒。
5. 追问旧标记，模型准确返回旧会话中的标记，证明恢复来自外部记录，而不是已删除的本地会话目录。

## 官方文档依据与网络验证

- `https://code.claude.com/docs/zh-CN/agent-sdk/session-storage.md`
  - 中国大陆显式直连：超时，HTTP 000，35.00 秒，无下载结果。
  - 授权代理：HTTP 200，0.93 秒，14,768 bytes，SHA-256 `0df158aece28ec509b0211daaf7b83376e77ae01bacaea5f1a1f8dfff9895c7d`。
- `https://code.claude.com/docs/zh-CN/agent-sdk/sessions.md`
  - 中国大陆显式直连：超时，HTTP 000，35.00 秒，无下载结果。
  - 授权代理：HTTP 200，0.88 秒，18,287 bytes，SHA-256 `3e97cb004384bf078372b296b7ccdd0d911749845e21dc288d17d528afb45b69`。

实现遵循官方 `SessionStore` 双写模型：本地记录先写入临时 `CLAUDE_CONFIG_DIR`，再镜像到文件适配器；恢复时 SDK 从外部存储重新物化会话。

## 已知边界

- Resume 恢复对话上下文，不恢复已销毁 AgentBay 沙盒里的文件系统。
- `/tmp` 可能被系统清理，仅用于 Demo；生产环境应把同一端口替换为持久卷、OSS/S3、Redis 或数据库适配器。
- 当前文件适配器面向单进程、Demo 规模会话；同一 session 的多进程并发写入需要对象存储分片或数据库事务。
