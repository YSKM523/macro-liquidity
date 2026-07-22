import { buildContinuousChallenger, buildWeeklyNetLiquidity } from './netliq-challenger.mjs';
import { evaluateNetLiquidityOos } from './netliq-oos.mjs';
import { PREREGISTRATION } from './netliq-preregistration.mjs';
import { verifySnapshotManifest } from './netliq-snapshot.mjs';

export async function runNetLiquidityResearch(snapshot, snapshotText, manifest, options = {}) {
  await verifySnapshotManifest(snapshot, snapshotText, manifest);
  const actualSeries = Object.keys(snapshot.series).sort();
  const expectedSeries = [...PREREGISTRATION.series].sort();
  if (JSON.stringify(actualSeries) !== JSON.stringify(expectedSeries)) {
    throw new Error('snapshot series do not match preregistration');
  }

  const weekly = buildWeeklyNetLiquidity(snapshot.series);
  const challenger = buildContinuousChallenger(weekly);
  const oos = evaluateNetLiquidityOos(challenger, snapshot.series.SP500, options);
  return {
    schemaVersion: 1,
    preregistrationStatus: PREREGISTRATION.status,
    evidenceClass: PREREGISTRATION.evidenceClass,
    snapshotId: manifest.snapshotId,
    snapshotSha256: manifest.snapshotSha256,
    retrievedAt: manifest.retrievedAt,
    sample: {
      weeklyPointCount: weekly.length,
      firstWeeklyDate: weekly[0]?.observationDate ?? null,
      lastWeeklyDate: weekly.at(-1)?.observationDate ?? null,
      rawScoredCount: challenger.filter(row => Number.isFinite(row.raw.score)).length,
      smoothScoredCount: challenger.filter(row => Number.isFinite(row.smooth.score)).length,
      highAgreementCount: challenger.filter(row => row.agreement.confidence === 'HIGH').length,
      lowAgreementCount: challenger.filter(row => row.agreement.confidence === 'LOW').length,
    },
    replacementEligible: false,
    decision: oos.decision,
    oos,
  };
}
