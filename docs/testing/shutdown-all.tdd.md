# 全账户 RUNNING 沙盒停机：TDD 与真实验收

## 目标

支持从 LAN WebApp、Ink TUI 和本机 CLI 关闭当前凭据所属账户在确认时已存在的全部 `RUNNING` AgentBay 沙盒。

> 这是账户级操作，不只匹配 `agentbay-ink-demo` 标签。

## 安全边界

- 三个入口统一要求精确确认短语：`SHUTDOWN ALL`。
- LAN Web 按最新要求无登录直连；写请求必须 JSON 且同源，错误短语返回 400，跨站请求 403，Agent 忙碌时返回 409。
- Web 与 TUI 在删除前先归档自己的 Claude JSONL；归档失败则取消该入口的停机。
- 本机 CLI 先显示当前 RUNNING 数量；无沙盒时幂等返回，不执行删除。
- 操作先完整分页快照并按 Session ID 去重，之后才并发删除，避免“删第一页后第二页前移”导致漏删。
- 删除采用结果汇总而非首错中断，返回 `attempted`、`deleted` 和逐项 `failures`。
- 另一入口关闭当前沙盒后，TUI/Web 会在账户刷新时切换为 `STOPPED`，不继续显示虚假的 `LIVE`。
- 快照完成后才新建的沙盒不属于本次确认范围；需要再次确认后执行。

## RED → GREEN

| 合约 | RED | GREEN |
|---|---|---|
| 应用层停机 | `shutdownAllRunning is not a function` | 完整分页快照、并发删除、部分失败测试通过 |
| TUI 确认门 | `/shutdown-all` 被当作普通 prompt | 无短语返回安全提示；仅完整命令映射为 `shutdownAll` |
| LAN 停机 API | `/api/shutdown-all` 返回 404 | 无登录直连；跨站 403、错误短语 400、忙碌 409、正确短语 200 |
| 跨入口状态 | 外部删除后本地 header 仍可能显示 LIVE | 暴露当前 sandbox ID；账户刷新发现缺失后关闭本地句柄并显示 STOPPED |

## 使用

LAN Web：点击红色“关闭全部沙盒”，在浏览器原生确认框输入 `SHUTDOWN ALL`。

TUI：

```text
/shutdown-all SHUTDOWN ALL
```

本机 CLI：

```bash
npm run shutdown-all -- --confirm "SHUTDOWN ALL"
```

## 真实受控验收

1. **LAN Web**：初始 2/10；错误确认返回 HTTP 400 且仍为 2/10；正确确认返回 `attempted=2 deleted=2 failed=0`，账户降为 0/10。
2. **本机 CLI**：从 TUI + Web 的 2/10 执行，输出 `SHUTDOWN_ALL_PASS attempted=2 deleted=2 failed=0`；随后两端均识别外部删除并显示 `STOPPED` / 0/10。
3. **Ink TUI**：从 2/10 输入完整确认命令，轨迹显示“全量停机完成：2/2 个 RUNNING 沙盒已关闭”；Web 刷新后识别 `destroyed` / 0/10。
4. 验收后重新启动 TUI + Web，最终托管状态恢复为 2/10；两个沙盒仍受 10 分钟空闲回收控制。

## 自动验证

- 最新 `npm run check`：23/23 测试、类型检查、构建通过。
- 最新 `npm run test:coverage`：行 92.83%、分支 80.38%、函数 87.96%。
- `npm audit --audit-level=high`：0 vulnerabilities。
