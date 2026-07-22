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
  return `# Continuous Net Liquidity Challenger — OOS Research Report

> This report was generated once from the frozen preregistration and immutable normalized snapshot. No formula, window, direction, fold, or gate was changed after observing results.

## Status and evidence

- Evidence class: \`${report.evidenceClass}\`
- Snapshot: \`${report.snapshotId}\`
- Snapshot SHA-256: \`${report.snapshotSha256}\`
- Retrieved at: \`${report.retrievedAt}\`
- replacementEligible: \`${report.replacementEligible}\`
- Evidence conclusion: \`${report.decision.evidenceConclusion}\`
- Research decision: \`${report.decision.decision}\`
- Production Champion: unchanged

This is current-vintage FRED research, not ALFRED/PIT evidence. Historical revisions may be present. Therefore even favorable diagnostics cannot replace the Champion in this PR.

## Sample

| Item | Value |
|---|---:|
| Weekly Raw/Smooth points | ${report.sample.weeklyPointCount} |
| Weekly range | ${report.sample.firstWeeklyDate} to ${report.sample.lastWeeklyDate} |
| Raw scored | ${report.sample.rawScoredCount} |
| Smooth scored | ${report.sample.smoothScoredCount} |
| HIGH agreement | ${report.sample.highAgreementCount} |
| LOW agreement | ${report.sample.lowAgreementCount} |

SPX current-vintage coverage determines the evaluable target window. Signals use WALCL Wednesday data, become nominally available Friday, and start at the first SPX close within seven calendar days; the target ends at the first close within seven days after 91 calendar days. Long missing-price gaps are never bridged.

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

## Frozen decision interpretation

The preregistered gate uses the agreement-confirmed non-overlapping IC, positive-fold count, bootstrap p-value, independent count, and agreement rate. The observed conclusion is **${report.decision.evidenceConclusion}** and the only allowed action selected by the gate is **${report.decision.decision}**. \`REPLACE_CHAMPION\` is not an available outcome.

## Known limitations

- FRED CSV is a current-vintage snapshot; it does not reconstruct historically visible releases or revisions.
- FRED SP500 coverage is shorter than the balance-sheet series, so early fixed folds can be empty. They are reported and never redistributed.
- The nominal Thursday-release/Friday-tradable lag is conservative research timing, but does not repair vintage bias.
- SP500 is a price index without dividends. This is an IC study, not a tradable portfolio backtest or Sharpe comparison.
- Overlapping 13-week observations are dependent; the non-overlapping sample and moving-block bootstrap are the more conservative diagnostics.
- Raw/Smooth agreement is a preregistered direction filter, not a fitted confidence calibration.

## Production impact and rollback

No Champion score, weight, threshold, verdict, hysteresis, portfolio target, official snapshot, API, migration, or production database is changed. Rollback is a code/docs/artifact revert of the PR-11 commit range; 无需数据库回滚。`;
}
