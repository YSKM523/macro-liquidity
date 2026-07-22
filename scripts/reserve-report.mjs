function num(value, digits = 4) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'null';
}

function pct(value, digits = 2) {
  return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(digits)}%` : 'null';
}

export function renderReserveReport(report) {
  const folds = report.oos.folds.map(fold => `| ${fold.fold} | ${fold.evaluationStart} | ${fold.evaluationEndExclusive} | ${fold.trainN} | ${fold.evaluationN} | ${num(fold.ic)} |`).join('\n');
  const quintiles = report.oos.quintiles.map(bucket => `| Q${bucket.quintile} | ${bucket.count} | ${pct(bucket.mean)} | ${pct(bucket.median)} | ${pct(bucket.negativeProbability)} | ${pct(bucket.tail10)} |`).join('\n');
  const states = Object.entries(report.sample.stateCounts).map(([state, count]) => `| ${state} | ${count} |`).join('\n');
  return `# Dynamic Reserve Adequacy Challenger — OOS Research Report

> Generated once from the frozen PR-12 canonical artifact and unchanged preregistered formula/gate. This is isolated shadow research; Champion: unchanged.

## Evidence and decision

- Methodology: \`${report.methodologyVersion}\`
- Evidence: \`${report.evidenceClass}\` — current-vintage research, not ALFRED/PIT
- Snapshot: \`${report.snapshotId}\`
- Snapshot SHA-256: \`${report.snapshotSha256}\`
- Retrieved at: \`${report.retrievedAt}\`
- replacementEligible: \`${report.replacementEligible}\`
- Research decision: \`${report.decision.decision}\`
- Champion: unchanged

FRED GDP is current-vintage quarterly data and is aligned only by observation date; no historical publication-date claim is made. Historical revisions remain a material limitation.

## A-001 source correction

The preregistered nonexistent FRED IDs returned 404 before full fetch. A-001 replaced them with exact FRED \`TGCRRATE\` and the official NY Fed Markets Repo API. The NY Fed daily SRF proxy sums \`totalAmtAccepted\` for same-day \`Repo\` / \`Overnight\` operations into billions. Formula, 0.30/0.25/0.25/0.20 weights, states, freshness, OOS target, gate, and eligibility did not change.

## A-002 SRF launch boundary correction

Independent review invalidated v1 because the Repo endpoint also contains temporary repo operations before the Standing Repo Facility. Canonical v2 requests NY Fed data from exactly **2021-07-29**, rejects earlier returned rows, and never uses v1 results. NY Fed small-value exercises remain included because the operation results API exposes no unambiguous exercise flag; they can overstate market-driven SRF take-up. This corrective run did not change the formula, weights, states, freshness, OOS target, gate, or eligibility.

## Sample and freshness

| Metric | Value |
|---|---:|
| Weekly Friday anchors | ${report.sample.weeklyCount} |
| Complete features | ${report.sample.completeCount} |
| DATA_INCOMPLETE features | ${report.sample.incompleteCount ?? report.sample.weeklyCount - report.sample.completeCount} |
| Scored after 52 prior complete weeks | ${report.sample.scoredCount} |
| Range | ${report.sample.firstAnchor} to ${report.sample.lastAnchor} |

Each weekly component carries independent as-of dates, ages, pair counts, and status. Missing/stale WRESBAL, GDP, same-date rate pairs, or NY Fed SRF results fail closed as \`DATA_INCOMPLETE\`; values are never replaced with zero or indefinitely forward-filled.

| State | Count |
|---|---:|
${states}

## Frozen OOS diagnostics

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | ${num(report.oos.overlapping.ic)} / ${report.oos.overlapping.n} |
| interval-non-overlapping Spearman IC / n | ${num(report.oos.nonOverlapping.ic)} / ${report.oos.nonOverlapping.n} |
| moving-block bootstrap 95% CI | [${num(report.oos.bootstrap.ciLow)}, ${num(report.oos.bootstrap.ciHigh)}] |
| bootstrap p(IC <= 0) | ${num(report.oos.bootstrap.pValue)} |
| positive fixed folds | ${report.oos.positiveFoldCount} / 6 |
| adjacent mean violations | ${report.oos.monotonicity.adjacentMeanViolations} |
| top mean no worse than bottom | ${report.oos.monotonicity.topNoWorseMean} |
| top 10% tail no worse than bottom | ${report.oos.monotonicity.topNoWorseTail10} |

| Fold | Start | End exclusive | Mature prior n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
${folds}

| Score quintile | n | Mean | Median | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
${quintiles}

The frozen gate selected **${report.decision.decision}**. The only possible outcomes are KEEP_SHADOW and DROP_RESEARCH; neither permits Champion replacement.

## Limitations and rollback

- Current-vintage FRED and NY Fed artifacts do not reconstruct historical vintages or historical availability.
- SP500 is a price index without dividends; this is an IC/state-ranking study, not a tradable portfolio backtest.
- Overlapping 13-week targets are dependent; interval-non-overlap and the seeded block bootstrap are the conservative diagnostics.
- A daily SRF accepted amount measures operation take-up, not every dimension of reserve scarcity.

No production source, API, official snapshot, Champion score, weight, threshold, hysteresis, portfolio policy, migration, or database is changed. Roll back the PR-12 code/docs/artifact commit range; no database rollback is required.`;
}
