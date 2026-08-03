# 临时前端预览与浏览器人工接管：TDD 证据

## 用户旅程

1. 同事让 Agent 开发临时前端 App 后，应得到真正可打开的页面，而不是只有终端输出或沙盒路径。
2. 测试者应能在自己的浏览器查看；需要共享浏览器状态时，可以打开 AgentBay 云浏览器并人工接管。
3. 测试者提交反馈后，Agent 能继续修改同一沙盒文件，预览保持可用。
4. 预览到期、手动停止、会话退出或全量停机时，HTTP 服务和浏览器资源必须一起回收。

## 六边形边界

- 应用层：`src/preview/application.ts`
  - `PreviewRuntimePort`
  - `PreviewApplication.publish/takeover/stop/current`
  - 目录、端口输入验证
- AgentBay 适配器：`src/sandbox.ts`
  - 静态 HTTP 服务、健康检查、`getLink`、Browser 初始化、`resourceUrl` 和统一销毁
- 入站适配器：
  - MCP：`publish_preview`、`browser_takeover`、`stop_preview`
  - Slash：`/preview`、`/takeover`、`/stop-preview`
  - Ink TUI 与 LAN Web 预览卡

## RED → GREEN

| 行为 | RED 证据 | GREEN 结果 |
|---|---|---|
| 预览应用层 | `ERR_MODULE_NOT_FOUND: src/preview/application.js` | 安全目录、默认端口和范围验证通过 |
| Web 发现性 | 页面缺少 `<code>/preview` | 命令面板、预览卡、打开/接管/反馈/停止入口测试通过 |
| 可审计轨迹 | `publish_preview` 被笼统显示成“执行远程命令” | 显示“发布临时前端预览”和“创建人工接管浏览器” |
| Basic 发布 | 真实 `GetLink` 返回 400：该能力仅 Pro/Ultra | 同一 `browser_latest` 在本地 `127.0.0.1:30100` 打开 App，返回 `resourceUrl` |
| 错误脱敏 | 真实错误会带 tenantId | `safeMessage` 隐藏租户、请求 ID 和凭据 |
| 发布安全 | 初版只检查 `index.html` | 拒绝符号链接、`.env*`/PEM/key 文件和超过 20 MiB 的目录 |

## 套餐兼容策略

```text
publish_preview
      |
      +-- Pro/Ultra: session.getLink(undefined, 30100)
      |                     -> 直接应用 URL
      |
      +-- Basic: GetLink 受限
                    -> 同一 browser_latest 初始化 Browser
                    -> defaultNavigateUrl=http://127.0.0.1:30100
                    -> session.info().data.resourceUrl
                    -> 浏览器预览 + 人工接管（二合一）
```

不为 Basic 额外创建第二个浏览器沙盒，避免复制文件、增加并行占用和双重生命周期。

## 自动测试保证

| 保证 | 测试 |
|---|---|
| 只接受 `/tmp`、`/home/wuying` 规范安全目录 | `test/preview.test.ts` |
| 只接受 30100–30199 | `test/preview.test.ts` |
| 静态服务健康后才返回 URL | `test/preview.test.ts` |
| 预览期间普通 10 分钟 idle 不会误杀，停止后恢复 | `test/preview.test.ts` |
| Basic 付费限制自动回退浏览器并打开本地地址 | `test/preview.test.ts` |
| `/stop-preview` 停服务并销毁 Browser | `test/preview.test.ts` |
| Slash 与 Web 完整入口可发现 | `test/preview.test.ts`、`test/web-server.test.ts` |
| 轨迹不泄漏工具输入/输出 | `test/agent-process.test.ts` |

## 真实 E2E

- 首次真实发布准确暴露限制：`GetLink is an exclusive premium feature for paid subscription users (Pro/Ultra)`。
- 独立能力探测：`BROWSER_BASIC_TAKEOVER_PASS command=true resource_url=true`，探测会话随后删除。
- Todo App 自动生成、语法验证、发布和接管：`TODO_PREVIEW_FALLBACK_E2E { ready: true, takeover: true }`。
- 人工接管 URL：HTTP 200，入口页 10,951 bytes，并已用系统默认浏览器打开。
- 反馈闭环：提交“团队待办 / 临时协作预览”修改，`TODO_FEEDBACK_LOOP_PASS preview=active`。
- 停止闭环：`PREVIEW_STOP_PASS sandbox=ready running=1`；预览/Browser 已停止，代码会话保留并恢复普通 idle。
- 最新 runtime 最终重发：`FINAL_TODO_PREVIEW_PASS mode=browser port=30100 running=2/10`；`FINAL_TAKEOVER_HTTP_PASS status=200 bytes=10951`。
- 最终交付前再次确认活动状态：`FINAL_PREVIEW_REPUBLISH_PASS mode=browser port=30100`；`FINAL_REPUBLISH_HTTP_PASS status=200 bytes=10951`；最终 `DELIVERY_LIVE_PASS preview=true takeover=true running=1/10`。
- Loop #13/#14 最终复核：`LOOP13_14_PREVIEW_READY mode=browser port=30100 running=1/10`；`LOOP14_HTTP_PASS status=200 bytes=10951`；接管 URL 仅写入本机 `0600` 临时文件，未进入报告。

## 最终验证

- 最新 `npm run check`：23/23，类型检查和构建通过。
- 最新 `npm run test:coverage`：行 92.83%、分支 80.38%、函数 87.96%。
- `npm audit --audit-level=high`：0 vulnerabilities。

## 已知边界

- 当前自动发布只服务静态目录；动态后端/API 预览不在本轮范围。
- 本账户是 Basic，Pro/Ultra 的直接端口链接由契约测试覆盖，未做真实付费套餐 E2E。
- Browser `resourceUrl` 是临时访问凭据；固定 TTL 默认 60 分钟，用完应 `/stop-preview`。
- 长期或公开展示应上传构建产物到 OSS 静态托管，并增加身份、审计和撤销策略。
