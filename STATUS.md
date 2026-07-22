# macro-liq — STATUS

> 美股流动性看板。CF Worker + D1。
> 目录 `~/macro-liquidity-dashboard` · 线上 `macro-liquidity-dashboard.pp-account.workers.dev`
> 部署：`wrangler deploy`（**改前端记得 bump `?v=` 版本号**，否则缓存不更新）
> API：`/api/health | /api/explain | /api/robustness | /api/global-liquidity`

_最后更新：2026-07-22（PR-15 purged validation 仅本地实现；未推送、未部署、未访问远程数据库）_

## PR-15 本地状态

- `PURGED_VALIDATION_V1` 已加入 `/api/walkforward`、`/api/robustness` 与 dashboard：正式标签使用 `tradableAt` 后首个合资格 PIT 日收盘入场、entry+91 日后首个实际 PIT 日收盘出场，并按 outcome purge/embargo；同时报告重叠/半开区间非重叠、方向/正式 verdict/风险/IC/尾部 typed metrics。
- 完全前瞻 holdout 已在真实 commit 时间登记，按 execution date 从 `2026-07-23` 开始；方向/verdict/risk/IC 当前必须是 `PENDING_MATURITY`，登记时没有诚实 tail threshold，因此前瞻 tail 永久为 `UNAVAILABLE_AT_REGISTRATION`，不能用历史数据补作 unseen 结果。
- governed 信号必须匹配登记的 Champion model/config；日价 PIT provenance 不完整、混合 cohort 或 post-holdout legacy 均 fail closed，API/UI 披露 cohort 与 provenance 计数。
- migration 0010 历史会显示 `PARTIAL_LEGACY`，legacy q10 calibration 为 null；非 PIT、畸形 provenance 与 post-holdout legacy fail closed。
- Champion 评分、权重、阈值、迟滞、stress 和仓位策略未改变；无 migration、push、部署或远程数据库操作。

## PR-13 本地状态

- 新快照具备 model/config/commit/data-run/cutoff/decision/created 身份；历史行由 additive 0010 标记为 `LEGACY_UNVERSIONED`。
- v1 API、结构化日志、SLO、管理员双认证/全量二次确认/审计、告警审计、短缓存/熔断已实现。
- CI、dev/staging/production 配置、受保护人工生产部署、dry-run 备份与本地恢复演练已配置。
- staging D1 仍是 `REPLACE_WITH_STAGING_D1`，因此 staging/production 均未验证或部署；没有创建或更改 secret。
- Champion 算法、权重、阈值、迟滞和仓位策略未改变。

## 当前状态
- **2026-07-17 三项优化已部署**（版本 ID `9979e093-4492-4ee1-bad4-89b71f68e20b`，`?v=0717a`；未 commit）。线上验证：readouts 行渲染真实数值、桌面 1280+移动 390 无横向溢出、0 console error；DXY 拼接生效（dxy_eod 07-15=119.94，dollar factor 17.4→42.4，score 59.1→63.6）；两条 cron 均注册。**Resend 三 secret 未配（RESEND_API_KEY/EMAIL_FROM/ALERT_EMAIL_TO），邮件告警静默停用，重试 cron 已生效**：
  1. **Ingest 加固**（`src/pipeline.ts` + service/worker/config/wrangler.toml）：新增 hourly 重试 cron `30 * * * *`（仅上次失败或成功摄取 >4h 时补跑，`shouldRetryIngest`）；连续第 2 次失败经 Resend 发邮件告警（`shouldAlert`，12h 限频，meta `last_alert_at`）。**部署时需 `wrangler secret put` 三个：`RESEND_API_KEY`（TCF worker 同款 key，本地无存档需用户提供）、`EMAIL_FROM`、`ALERT_EMAIL_TO`**；不配则告警静默降级、重试仍生效。
  2. **DXY 拼接**（`spliceSeries`/`fetchDxyDaily` in prices.ts，接在 runIngest）：DTWEXBGS 官方滞后约 1 周，用 Yahoo DX-Y.NYB 日线按比例链到序列末端参与打分（仅内存，行情失败自动跳过）；snapshot 日期上限是 WALCL 最新日，故不会用到盘中值。
  3. **stress 实时读数**（前端）：触发器区块末尾新增一行 `实时读数 VIX x/线 28 · SPX5日 …`（`live_stress.signals` + 新增 `thresholds` 字段），让「未触发」可核验。`?v=0717a`。
- 背景事件：2026-07-17 早 FRED RRPONTSYD 502 致 ingest 卡 stale 5.5h，人工 `POST /api/admin/refresh` 恢复——上述第 1 项就是针对此事故。
- 工作区另有 07-14 的 Current Regime 卡片优化（状态色大字/`#regime-token` chip/kicker 重叠修复）**未 commit**（用户未要求），线上是 `?v=0714a`（版本 ID `833f298a`）。
- 历史已修复：手机横向滚动、favicon、首页全屏 command center、左侧 Primary Screen 细分小卡片、去除红色细线、去除渐变/透明 UI 风格。

## 验证记录
- PR-15：`npm test -- --reporter=dot` 752 个测试通过；TypeScript strict、ESLint、correctness、no-lookahead、rebuild consistency、0001–0010 本地 migration 双跑和 staging dry-run 全部通过。
- `env -u NODE_OPTIONS npm test`：13 个测试文件、248 个测试通过。
- `env -u NODE_OPTIONS npx tsc --noEmit`：通过。
- 线上桌面验证：`1920x1080`、`2560x1440`、`3840x2160` 首页均无页面级上下滚动，核心面板在首屏内完整显示。
- 线上移动端验证：`390x844` 无横向滚动；`/algorithm` 移动端表格使用横向表格容器，不撑宽页面。
- 浏览器控制台：0 error / 0 warning。

## 关键事实（memory `project_macro_liquidity_dashboard`）
- 含 stress / walkforward / backtest 护栏。
- 姊妹项目：加拿大版 `~/ca-liquidity-dashboard`（`ca-liquidity-dashboard.pp-account.workers.dev`，BoC 结算余额 + TSX + CAD/USD）；诚实结论 = 无显著 alpha（IC≈0）的弱宏观监控（`project_ca_liquidity_dashboard`）。

## 下一步
- 配 Resend 三 secret 以启用邮件告警：`npx wrangler secret put RESEND_API_KEY / EMAIL_FROM / ALERT_EMAIL_TO`（key 需用户从 resend.com 取，与 TCF worker 同一账号）。
- 后续微调前端记得 bump `?v=`。
