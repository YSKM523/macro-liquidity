import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { runReserveResearch } from '../scripts/run-reserve-research.mjs';
// @ts-ignore -- isolated Node research module
import { buildReserveManifest, fredCsvUrl, nyFedRepoUrl } from '../scripts/reserve-snapshot.mjs';

const DAY = 86_400_000;
const iso = (base: string, days: number) => new Date(Date.parse(`${base}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

async function fixture() {
  const ids = ['WRESBAL', 'GDP', 'SOFR', 'IORB', 'EFFR', 'TGCRRATE', 'SP500'];
  const endDate = '2022-06-30';
  const weekly = Array.from({ length: 130 }, (_, index) => ({ date: iso('2020-01-01', index * 7), value: 3_000_000 + index * 1_000 }));
  const daily = Array.from({ length: 911 }, (_, index) => ({ date: iso('2020-01-01', index), value: 1 + index / 10_000 }));
  const series: any = {
    WRESBAL: weekly,
    GDP: Array.from({ length: 11 }, (_, index) => ({ date: iso('2020-01-01', index * 91), value: 22_000 + index * 100 })),
    SOFR: daily.map(row => ({ ...row, value: 1.01 + Number(row.value) / 100 })),
    IORB: daily.map(row => ({ ...row, value: 1.10 + Number(row.value) / 100 })),
    EFFR: daily.map(row => ({ ...row, value: 1.02 + Number(row.value) / 100 })),
    TGCRRATE: daily.map(row => ({ ...row, value: 1.00 + Number(row.value) / 100 })),
    NYFED_SRF_ACCEPTED: daily.map(row => ({ ...row, value: indexMod(row.date, 7) === 0 ? 1 : 0 })),
    SP500: daily.map((row, index) => ({ date: row.date, value: 3_000 + index })),
  };
  const fredUrls = Object.fromEntries(ids.map(id => [id, fredCsvUrl(id, endDate)]));
  const snapshot = { schemaVersion: 1, snapshotId: 'fixture', evidenceClass: 'RESEARCH_CURRENT_VINTAGE', retrievedAt: '2022-06-30T12:00:00.000Z', source: 'FRED_AND_NYFED_CURRENT_VINTAGE', request: { startDate: '2002-01-01', endDate, fredUrls, nyFedUrl: nyFedRepoUrl('2002-01-01', endDate) }, series };
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  const hashes = Object.fromEntries([...ids, 'NYFED_SRF_ACCEPTED'].map(id => [id, 'b'.repeat(64)]));
  return { snapshot, text, manifest: await buildReserveManifest(snapshot, text, hashes) };
}

function indexMod(date: string, divisor: number) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY) % divisor;
}

describe('reserve research frozen runner', () => {
  it('verifies the artifact, builds Friday features/scores, evaluates OOS once, and blocks replacement', async () => {
    const { snapshot, text, manifest } = await fixture();
    const report = await runReserveResearch(snapshot, text, manifest, { bootstrapIterations: 20 });
    expect(report).toMatchObject({
      methodologyVersion: 'PR12_RESEARCH_V1_SOURCE_CORRECTED', evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      snapshotId: 'fixture', replacementEligible: false,
      sample: { weeklyCount: expect.any(Number), completeCount: expect.any(Number), scoredCount: expect.any(Number) },
      oos: { folds: expect.any(Array), decision: { replacementEligible: false } },
    });
    expect(report.sample.weeklyCount).toBeGreaterThan(100);
    expect(report.sample.scoredCount).toBeGreaterThan(20);
    expect(['KEEP_SHADOW', 'DROP_RESEARCH']).toContain(report.decision.decision);
  });
});
