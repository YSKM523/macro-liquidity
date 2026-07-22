// @ts-ignore -- project tsconfig intentionally loads Workers rather than Node types
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-ignore -- isolated Node research module
import { runNetLiquidityResearch } from '../scripts/run-netliq-research.mjs';

const snapshotText = readFileSync('scripts/data/netliq-current-vintage-2026-07-22.json', 'utf8');
const snapshot = JSON.parse(snapshotText);
const manifest = JSON.parse(readFileSync('scripts/data/netliq-current-vintage-2026-07-22.manifest.json', 'utf8'));

describe('net-liquidity research runner', () => {
  it('verifies the frozen artifact and produces deterministic shadow-only diagnostics', async () => {
    const first = await runNetLiquidityResearch(snapshot, snapshotText, manifest, { bootstrapIterations: 100 });
    const second = await runNetLiquidityResearch(snapshot, snapshotText, manifest, { bootstrapIterations: 100 });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      evidenceClass: 'RESEARCH_CURRENT_VINTAGE',
      snapshotSha256: manifest.snapshotSha256,
      replacementEligible: false,
    });
    expect(first.sample.weeklyPointCount).toBeGreaterThan(1_000);
    expect(first.sample.rawScoredCount).toBeGreaterThan(900);
    expect(first.oos.raw.overlapping.n).toBeGreaterThan(400);
  });

  it('rejects a snapshot whose bytes no longer match the manifest', async () => {
    await expect(runNetLiquidityResearch(snapshot, `${snapshotText} `, manifest, { bootstrapIterations: 10 }))
      .rejects.toThrow(/SHA-256/);
  });
});
