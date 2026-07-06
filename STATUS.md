# macro-liq — STATUS

> 美股流动性看板。CF Worker + D1。
> 目录 `~/macro-liquidity-dashboard` · 线上 `macro-liquidity-dashboard.pp-account.workers.dev`
> 部署：`wrangler deploy`（**改前端记得 bump `?v=` 版本号**，否则缓存不更新）
> API：`/api/health | /api/explain | /api/robustness | /api/global-liquidity`

_最后更新：2026-07-06（本轮一屏 dashboard 重排、移动端与 favicon 修复后刷新）_

## 当前状态
- 分支：`main`；本轮目标是把首页改成更紧凑的全屏 dashboard，32 寸 / 27 寸桌面视口无需上下滚动即可看完整核心信息。
- 线上版本：`https://macro-liquidity-dashboard.pp-account.workers.dev/`，最近部署 ID `5861236d-91b7-4533-8ef6-e2fd7c92fe1f`。
- 前端缓存版本：`styles.css?v=0624g`、`app.js?v=0624g`。
- 已修复：手机横向滚动、favicon、首页全屏 command center、左侧 Primary Screen 细分小卡片、去除红色细线、去除渐变/透明 UI 风格。

## 验证记录
- `env -u NODE_OPTIONS npm test`：13 个测试文件、248 个测试通过。
- `env -u NODE_OPTIONS npx tsc --noEmit`：通过。
- 线上桌面验证：`1920x1080`、`2560x1440`、`3840x2160` 首页均无页面级上下滚动，核心面板在首屏内完整显示。
- 线上移动端验证：`390x844` 无横向滚动；`/algorithm` 移动端表格使用横向表格容器，不撑宽页面。
- 浏览器控制台：0 error / 0 warning。

## 关键事实（memory `project_macro_liquidity_dashboard`）
- 含 stress / walkforward / backtest 护栏。
- 姊妹项目：加拿大版 `~/ca-liquidity-dashboard`（`ca-liquidity-dashboard.pp-account.workers.dev`，BoC 结算余额 + TSX + CAD/USD）；诚实结论 = 无显著 alpha（IC≈0）的弱宏观监控（`project_ca_liquidity_dashboard`）。

## 下一步
- 无已知阻塞；后续如果继续微调前端，记得同步 bump `?v=` 并重新部署。
