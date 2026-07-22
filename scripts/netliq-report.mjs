function value(value, digits = 4) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'null';
}

function percent(value, digits = 2) {
  return Number.isFinite(value) ? `${(Number(value) * 100).toFixed(digits)}%` : 'null';
}

function diagnosticSection(name, diagnostic) {
  const folds = diagnostic.folds.map(fold =>
    `| ${fold.fold} | ${fold.evaluationStart} | ${fold.evaluationEndExclusive} | ${fold.trainN} | ${fold.evaluationN} | ${value(fold.ic)} |`,
  ).join('\n');
  const quintiles = diagnostic.quintiles.map(bucket =>
    `| Q${bucket.quintile} | ${bucket.count} | ${percent(bucket.mean)} | ${percent(bucket.median)} | ${percent(bucket.negativeProbability)} | ${percent(bucket.tail10)} |`,
  ).join('\n');
  return `### ${name}

| Metric | Value |
|---|---:|
| overlapping Spearman IC / n | ${value(diagnostic.overlapping.ic)} / ${diagnostic.overlapping.n} |
| non-overlapping Spearman IC / n | ${value(diagnostic.nonOverlapping.ic)} / ${diagnostic.nonOverlapping.n} |
| moving-block bootstrap 95% CI | [${value(diagnostic.bootstrap.ciLow)}, ${value(diagnostic.bootstrap.ciHigh)}] |
| bootstrap p(IC <= 0) | ${value(diagnostic.bootstrap.pValue)} |
| positive folds | ${diagnostic.positiveFoldCount} / 6 |
| sign stability | ${percent(diagnostic.signStability)} |

| Fold | Start | End exclusive | Prior prefix n | Evaluation n | IC |
|---:|---|---|---:|---:|---:|
${folds}

| Score bucket | n | Mean return | Median return | P(return < 0) | 10% tail |
|---|---:|---:|---:|---:|---:|
${quintiles}`;
}

export function renderNetLiquidityReport(report) {
  const amendmentRows = (report.amendments ?? []).map(amendment =>
    `| ${amendment.id} | ${amendment.kind} | ${amendment.implementationCommit} | ${amendment.change} |`,
  ).join('\n');
  return `# Continuous Net Liquidity Challenger — Corrected OOS Research Report

> This corrected report was generated once from the canonical schema-v2 snapshot after independent review amendments. The formula, 0.45/0.35/0.20 weights, prior-only MAD, fixed folds, target horizon, bootstrap, and decision gate were not tuned. Timing and artifact provenance were corrected and are disclosed below; the initial report is \`INVALIDATED_BY_REVIEW\`.

## Status and evidence

- Evidence class: \`${report.evidenceClass}\`
- Methodology version: \`${report.methodologyVersion}\`
- Contract status: \`${report.preregistrationStatus}\`
- Snapshot schema: \`${report.schemaVersion}\`
- Snapshot: \`${report.snapshotId}\`
- Snapshot SHA-256: \`${report.snapshotSha256}\`
- Retrieved at: \`${report.retrievedAt}\`
- replacementEligible: \`${report.replacementEligible}\`
- Evidence conclusion: \`${report.decision.evidenceConclusion}\`
- Research decision: \`${report.decision.decision}\`
- Production Champion: unchanged

This is current-vintage FRED research, not ALFRED/PIT evidence. Historical revisions may be present. Therefore even favorable diagnostics cannot replace the Champion in this PR.

## Amendment disclosure

| ID | Kind | Implementation commit | Change |
|---|---|---|---|
${amendmentRows}

- A-001 is a review-triggered correctness amendment: the conservative availability bound is now **Wed+7** calendar days before selecting the first eligible SPX close.
- A-002 is \`POST_FETCH_DATA_HYGIENE\`: the seven-day SPX start/end gap cap was added after the initial data fetch but before the initial formal report; it was not preregistered.
- A-003 is the review-triggered schema-v2 trust boundary and exact id/cosd/coed provenance validation.
- The initial JSON/Markdown remain audit-only under \`*_INITIAL_INVALIDATED.*\`; this corrected output is the canonical PR-11 report.

## Sample

| Item | Value |
|---|---:|
| Weekly Raw/Smooth points | ${report.sample.weeklyPointCount} |
| Weekly range | ${report.sample.firstWeeklyDate} to ${report.sample.lastWeeklyDate} |
| Raw scored | ${report.sample.rawScoredCount} |
| Smooth scored | ${report.sample.smoothScoredCount} |
| HIGH agreement | ${report.sample.highAgreementCount} |
| LOW agreement | ${report.sample.lowAgreementCount} |

SPX current-vintage coverage determines the evaluable target window. Signals use WALCL Wednesday data, reach the conservative availability bound seven calendar days later, and start at the first SPX close within seven calendar days after that bound; the target ends at the first close within seven days after 91 calendar days. Long missing-price gaps are never bridged.

## OOS diagnostics

${diagnosticSection('Raw', report.oos.raw)}

${diagnosticSection('Smooth', report.oos.smooth)}

${diagnosticSection('Agreement-confirmed', report.oos.agreementConfirmed)}

## Raw / Smooth agreement

| Metric | Value |
|---|---:|
| Comparable observations | ${report.oos.agreement.comparableCount} |
| HIGH agreement | ${report.oos.agreement.confirmedCount} |
| LOW disagreement | ${report.oos.agreement.disagreementCount} |
| Agreement rate | ${percent(report.oos.agreement.rate)} |
| Disagreement mean forward return | ${percent(report.oos.disagreement.meanForwardReturn)} |
| Disagreement median forward return | ${percent(report.oos.disagreement.medianForwardReturn)} |
| Disagreement negative probability | ${percent(report.oos.disagreement.negativeProbability)} |

## Unchanged decision-gate interpretation

The original unchanged gate uses the agreement-confirmed non-overlapping IC, positive-fold count, bootstrap p-value, independent count, and agreement rate. The corrected observed conclusion is **${report.decision.evidenceConclusion}** and the only allowed action selected by the gate is **${report.decision.decision}**. \`REPLACE_CHAMPION\` is not an available outcome.

## Known limitations

- FRED CSV is a current-vintage snapshot; it does not reconstruct historically visible releases or revisions.
- FRED SP500 coverage is shorter than the balance-sheet series, so early fixed folds can be empty. They are reported and never redistributed.
- The review-amended Wed+7 bound is deliberately conservative and avoids the demonstrated holiday-release error, but it is not a historical release calendar and does not repair vintage bias.
- SP500 is a price index without dividends. This is an IC study, not a tradable portfolio backtest or Sharpe comparison.
- Overlapping 13-week observations are dependent; the non-overlapping sample and moving-block bootstrap are the more conservative diagnostics.
- Raw/Smooth agreement is a preregistered direction filter, not a fitted confidence calibration.

## Production impact and rollback

No Champion score, weight, threshold, verdict, hysteresis, portfolio target, official snapshot, API, migration, or production database is changed. Rollback is a code/docs/artifact revert of the PR-11 commit range; 无需数据库回滚。`;
}
