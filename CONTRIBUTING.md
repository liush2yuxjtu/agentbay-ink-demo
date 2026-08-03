# 贡献指南

1. 使用 Node.js 22+，执行 `npm ci`。
2. 修改前先运行 `npm run check`；涉及行为时补充最小测试。
3. 提交前再次运行 `npm run check && npm audit --audit-level=high`。
4. 不得提交 `.env`、API Key、会话归档、临时预览 URL 或 `.agent/` 运行时检查点。

提交信息保持简短，说明行为变化及验证证据。
