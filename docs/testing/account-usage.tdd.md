# AgentBay 远端并行与按量消费：TDD 证据

## 目标

在 Ink TUI 中展示全部 `RUNNING` 沙盒、Basic 并行占用与参考燃烧率，并在底部状态行读取阿里云官方 BSS 已入账的 AgentBay 按量消费，而不是套餐购买金额。

## 数据边界

| 数据 | 官方接口 | 展示/落盘 |
|---|---|---|
| 运行会话 | `AgentBay.list({}, page, 10, "RUNNING")` | TUI 显示全部 session ID、状态、镜像 |
| 实时规格 | `AgentBay.get(id)` + `session.getMetrics()` | CPU、内存、参考小时成本 |
| 已入账按量消费 | `DescribeInstanceBill` + `ProductCode=gws` + `SubscriptionType=PayAsYouGo` | 按 `NextToken` 分页，仅保留 AgentBay 按量计费项，`0600` JSON 与状态行 |

30 秒自动刷新只调用账户级 `list()`，不会调用具体会话的工具或 Metrics；启动和手工 `/sandboxes` 才刷新 Metrics。

## RED → GREEN

| 行为 | RED 证据 | GREEN 证据 |
|---|---|---|
| 全账户分页与并行统计 | `ERR_MODULE_NOT_FOUND: src/account/application.js` | 分页测试确认 3 个远端会话、Basic 3/10 与 30% |
| TUI 新命令 | `/sandboxes` 被错误解析成普通 prompt | `/sandboxes`、`/sessions`、`/bill` 均通过命令测试 |
| 安全消费导出 | 缺少 BSS 适配器 | 固定 PayAsYouGo 查询、分页、AgentBay 行过滤、`0600` 和无 RequestId 测试通过 |
| 低影响自动刷新 | list-only 测试发现 Metrics 查询从 3 次增长到 6 次 | 缓存 Metrics 后，自动刷新维持 3 次且保留估算 |
| 官方费率冲突 | 单一估算无法表达官方文档内的 CPU 口径冲突 | TUI 改为显示低/高参考区间 |
| 套餐与消费混淆 | `SubscriptionOrder` 的 ¥0.01 套餐购买金额被展示成资源花费 | 解析器只接受 `PayAsYouGo` / `PayAsYouGoBill`，套餐行回归测试确认被排除 |
| TUI 状态行 | 只显示命令提示，官方消费必须手工 `/bill` 后从消息中寻找 | 启动即读取官方消费；状态行展示读取中、已入账、零消费或失败，`/bill` 可刷新 |

## 官方依据

官方计费页：`https://help.aliyun.com/zh/agentbay/product-overview/agentbay-billing-instructions`

官方消费汇总 API：`https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-describeinstancebill`

- Basic 权益包免费，但计算资源仍后付费；会话并行授权为 10。
- 只要会话处于运行中，即使内部进程空闲，CPU 与内存仍持续计费。
- 内存单价为 `0.05 元/GiB/小时`。
- 同一页面 CPU 单价表为 `0.12 元/核/小时`，后面的计费示例使用 `0.20 元/核/小时`。实现因此显示区间，并允许通过环境变量校准，而不声称一个虚假精确值。

双网络下载验证（2026-07-29）：AgentBay 计费页和 DescribeInstanceBill API 文档均在中国大陆直连、授权代理两条路径返回 HTTP 200。

## 官方 API 实测

官方 BSS 服务为 `BssOpenApi`（版本 `2017-12-14`）：

- `QueryBillOverview`：产品级账单总览，包含购买/支付，不适合直接当资源花费。
- `QueryBill` / `QuerySettleBill`：结算账单。
- `QueryAccountBill`：账号消费汇总，但 `gws` 粒度无法安全区分其他无影产品。
- `DescribeInstanceBill`：官方“消费汇总”计费项，支持 `ProductCode`、`SubscriptionType` 和 `NextToken`，因此用于状态行。

当前账期实测：

- 未过滤的 BSS 中有一条 `SubscriptionOrder`：无影AI Agent积分包，原价 `¥120.00`、优惠后支付 `¥0.01`。这是已购套餐，**不是资源消费**，现已排除。
- `DescribeInstanceBill(ProductCode=gws, SubscriptionType=PayAsYouGo)` 返回 0 条，因此官方当前已入账 AgentBay 按量消费为 `¥0.00`。
- 运行中沙盒仍按 Metrics 动态显示参考燃烧率；BSS 计量可能延迟，状态行不会把 `¥0.00` 表述成最终费用。

## 自动验证

- 最新 `npm run check`：类型检查、23/23 测试、构建均通过。
- 最新 `npm run test:coverage`：行 92.83%、分支 80.38%、函数 87.96%。
- `npm audit --audit-level=high`：0 vulnerabilities。
- `npm run account:smoke`：真实账户返回 `ACCOUNT_PASS`；官方消费返回 `BILL_SPEND_PASS cycle=2026-07 gross_cny=0.00 charged_cny=0.00`。
- 当前 `browser_latest` 同样按 Metrics 展示真实 CPU/内存；运行数量与费用以每次 `ACCOUNT_PASS` 为准。

## Herdr 真实界面验证

当前第 2 个 Herdr tab 显示：

- `AgentBay Basic · 并行 1/10（10%）`
- 远端会话 ID、`RUNNING`、镜像、2C/4GiB、每小时参考区间
- `/sandboxes` 刷新成功
- 底部状态行：`BSS 2026-07 · 已入账按量消费 ¥0.00 · 运行中费用可能延迟`
- `/bill` 刷新并导出 `/tmp/agentbay-spend-2026-07.json`

消费文件权限为 `0600`，不含套餐购买、账号、RequestId 或其他无影产品数据。

## 已知边界

- 当前小时估算只覆盖成功返回 Metrics 的运行会话，不是累计消费。
- BSS 状态是“已入账消费”，不是实时计价；运行中或刚结束会话可能延迟出现。
- 仅匹配 AgentBay ProductType/Detail 与 PayAsYouGo 类型，不会把套餐或其他 `gws` 无影产品误算为资源花费。
- Basic 上限、CPU 与内存单价都提供环境变量，以应对套餐或官方费率变化。
