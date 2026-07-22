# Command Center Redesign Design

## Goal

Redesign the existing macro liquidity dashboard into a full-screen "One-Screen Command Center" while preserving the current data model, API routes, chart library, algorithm page, and favicon/mobile overflow fixes.

The first viewport should feel like a control-room screen: decisive, immersive, dense enough for market use, and visually more premium than the current stacked card layout.

## Page Type And Audience

This is a research and risk dashboard for a market user who wants a fast read on whether macro liquidity is a tailwind or headwind for US equities. The user values speed, precision, and confidence over marketing copy.

## Visual Direction

Use an Awwwards-inspired command center treatment, not a marketing landing page:

- Full-screen first viewport with a dark control-room stage.
- Thin top status bar with compact metadata.
- Large verdict and score as the primary visual anchor.
- Main chart as the dominant content surface.
- Factor wall as a compact matrix of live model internals.
- Fine grid lines, hairline borders, small uppercase labels, and status color accents.
- Motion is restrained: entrance reveal, bar-fill transitions, hover/focus feedback. No scroll hijacking, WebGL, or heavy animation library.

## First Viewport Structure

`main.container` becomes a full-width shell rather than a fixed-width centered stack.

First viewport module:

- `topbar`
  - Left: product name.
  - Middle/right: live market ticker, FRED data date, factor coverage.
  - Right: algorithm link.
- `.command-center`
  - Left panel `.decision-panel`
    - verdict label
    - score number and gauge
    - reason
    - regime metadata
    - guidance tier, exposure, lean, triggers
  - Center panel `.chart-panel`
    - chart title and legend
    - large `#chart` canvas area
  - Right panel `.factor-panel`
    - 8 scoring-factor rows rendered by the existing `renderScore` data path; legacy zero-weight `vol` is not a Factor Wall row
    - factor rows retain labels, bar tracks, values, and up/down/flat coloring

The current standalone verdict card, guidance card, score card, and chart card should be merged into this first viewport. The DOM can be restructured, but existing element IDs should remain where practical so current JS data binding remains simple.

## Below-The-Fold Structure

Below the command center, retain the existing analytical sections:

- Score attribution / explanation.
- Factor detail table.
- Backtest robustness.
- Global liquidity display.
- Data provenance.

These become a secondary `.analysis-grid` with varied panel spans instead of a one-column stack of identical cards.

## Responsive Behavior

Desktop:

- First viewport fills `min-height: 100svh`.
- Layout uses 3 columns: decision panel, chart panel, factor panel.
- Chart column is the largest area.

Tablet:

- Two-column layout: decision panel and factor panel above or beside the chart depending on available width.
- Chart remains prominent and at least 420px high.

Mobile:

- Single-column layout.
- First viewport may exceed one screen vertically, but page-level horizontal scroll must remain zero.
- Decision panel comes first, chart second, factor wall third.
- Existing mobile collapsible behavior for secondary analysis sections remains.
- Touch targets remain comfortable and text must not overlap or clip.

## JavaScript Changes

Keep the current data fetch flow:

- `/api/snapshot`
- `/api/history`
- `/api/explain`
- `/api/robustness`
- `/api/global-liquidity`

Expected changes:

- `renderGuidance` should target elements inside the decision panel and avoid replacing the entire card class in a way that removes layout classes.
- `renderVerdict` should style the command center state using status classes on the decision panel or command center shell.
- `renderChart` should derive height from CSS/container size or be adjusted to fill the chart panel cleanly.
- `renderScore` continues rendering factor rows into `#factor-bars`.

No algorithm or API behavior changes.

## Error And Loading States

Loading:

- First viewport should have stable placeholder content; chart and metrics should not cause layout jumps.

API error:

- Existing stress/error banner remains visible inside the decision panel.

No data:

- The command center shell should remain styled and show the existing "暂无数据" message.

## Testing And Verification

Automated:

- Existing Vitest suite must pass.
- Keep or extend `test/ui-assets.test.ts` for mobile overflow and favicon constraints.
- Add static checks for the command-center shell if useful.
- TypeScript check must pass with `npx tsc --noEmit`.

Browser:

- Start local Worker with Wrangler.
- Verify desktop screenshot around 1440x900: first viewport is full-screen and nonblank.
- Verify mobile screenshot around 390x844: no page-level horizontal scroll and no overlapping text.
- Verify `/algorithm` still renders correctly.
- Verify console has no errors or warnings.
- Verify deployed site after `npm run deploy`.

## Out Of Scope

- Changing scoring logic, factor weights, API response shape, D1 schema, cron ingestion, or algorithm documentation content.
- Adding new charting libraries, WebGL, smooth-scroll libraries, or external font/CDN dependencies.
- Reworking the `/algorithm` page beyond keeping shared styles compatible.
