import { buildWeeklyReserveFeatures, scoreReserveFeatures } from './reserve-challenger.mjs';
import { evaluateReserveOos } from './reserve-oos.mjs';
import { PREREGISTRATION } from './reserve-preregistration.mjs';
import { verifyReserveSnapshot } from './reserve-snapshot.mjs';

const DAY_MS = 86_400_000;

function fridayAnchors(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const day = new Date(start).getUTCDay();
  const offset = (5 - day + 7) % 7;
  const anchors = [];
  for (let time = start + offset * DAY_MS; time <= Date.parse(`${endDate}T00:00:00Z`); time += 7 * DAY_MS) {
    anchors.push(new Date(time).toISOString().slice(0, 10));
  }
  return anchors;
}

function counts(rows, selector) {
  return rows.reduce((result, row) => {
    const key = selector(row);
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
}

export async function runReserveResearch(snapshot, snapshotText, manifest, options = {}) {
  const verified = await verifyReserveSnapshot(snapshot, snapshotText, manifest);
  const series = verified.snapshot.series;
  const anchors = fridayAnchors(series.WRESBAL[0].date, verified.snapshot.request.endDate);
  const features = buildWeeklyReserveFeatures(series, anchors);
  const scored = scoreReserveFeatures(features);
  const oos = evaluateReserveOos(scored, series.SP500, options);
  const scoredRows = scored.filter(row => Number.isFinite(row.score));
  const decision = { ...oos.decision, replacementEligible: false };
  return {
    schemaVersion: verified.schemaVersion,
    preregistrationStatus: PREREGISTRATION.status,
    methodologyVersion: PREREGISTRATION.methodologyVersion,
    amendments: PREREGISTRATION.amendments,
    evidenceClass: PREREGISTRATION.evidenceClass,
    source: PREREGISTRATION.source,
    snapshotId: verified.snapshotId,
    snapshotSha256: verified.snapshotSha256,
    retrievedAt: verified.retrievedAt,
    replacementEligible: false,
    sample: {
      weeklyCount: scored.length,
      completeCount: scored.filter(row => row.decisionStatus === 'OK').length,
      incompleteCount: scored.filter(row => row.decisionStatus !== 'OK').length,
      scoredCount: scoredRows.length,
      firstAnchor: scored[0]?.anchorDate ?? null,
      lastAnchor: scored.at(-1)?.anchorDate ?? null,
      decisionStatusCounts: counts(scored, row => row.decisionStatus),
      stateCounts: counts(scoredRows, row => row.state),
    },
    latest: scored.at(-1) ?? null,
    oos,
    decision,
  };
}
