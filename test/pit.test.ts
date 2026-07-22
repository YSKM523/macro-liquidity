import { describe, expect, it } from 'vitest';
// @ts-ignore Node test runtime Web Crypto shim.
import { webcrypto } from 'node:crypto';
import { availableForExecution, buildPitFrames, deriveReleaseTiming, iteratePitFrames, pitChecksum } from '../src/pit';
import { SERIES_IDS } from '../src/config';
import type { PitObservation } from '../src/pit';

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('PIT release timing', () => {
  it('uses observed fetch time only for same-day vintages and next-weekday tradability', () => {
    expect(deriveReleaseTiming('2024-01-05', '2024-01-05T18:00:00Z', '23:59:59')).toEqual({
      releasedAt: '2024-01-05T18:00:00Z', tradableAt: '2024-01-08T14:30:00Z',
      releaseTimeStatus: 'OBSERVED_AT_FETCH',
    });
    expect(deriveReleaseTiming('2024-01-04', '2024-01-05T18:00:00Z', '23:59:59').releasedAt)
      .toBe('2024-01-04T23:59:59Z');
  });

  it('honors strict overrides and rejects malformed timing data', () => {
    expect(deriveReleaseTiming('2024-01-04', '2024-01-05T18:00:00Z', '12:00:00', {
      releasedAt: '2024-01-04T13:00:00Z', tradableAt: '2024-01-04T14:30:00Z',
    }).releaseTimeStatus).toBe('OVERRIDE');
    expect(() => deriveReleaseTiming('not-date', '2024-01-05T18:00:00Z', '23:59:59')).toThrow(/date/i);
  });

  it('hashes a canonical vintage identity', async () => {
    const first = await pitChecksum('WALCL', '2024-01-03', '2024-01-04', 5800);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await pitChecksum('WALCL', '2024-01-03', '2024-01-04', 5800)).toBe(first);
  });
});

describe('PIT timeline', () => {
  const row = (part: Partial<PitObservation>): PitObservation => ({
    seriesId: 'WALCL', observationDate: '2024-01-03', vintageDate: '2024-01-04',
    releasedAt: '2024-01-04T23:59:59Z', fetchedAt: '2024-01-10T12:00:00Z',
    tradableAt: '2024-01-05T14:30:00Z', source: 'ALFRED', checksum: 'a',
    releaseTimeStatus: 'CONSERVATIVE_DATE_END', value: 5800, ...part,
  });

  it('never exposes future releases or future revisions and materializes a complete manifest', () => {
    const rows = [
      row({}),
      row({ vintageDate: '2024-01-08', releasedAt: '2024-01-08T23:59:59Z', checksum: 'b', value: 5900 }),
      row({ seriesId: 'SP500', observationDate: '2024-01-05', vintageDate: '2024-01-06',
        releasedAt: '2024-01-06T23:59:59Z', tradableAt: '2024-01-08T14:30:00Z', checksum: 's', value: 4700 }),
    ];
    const frames = buildPitFrames(rows, [
      { modelDate: '2024-01-05', decisionAt: '2024-01-05T00:00:00Z', tradableAt: '2024-01-05T14:30:00Z' },
      { modelDate: '2024-01-08', decisionAt: '2024-01-09T00:00:00Z', tradableAt: '2024-01-09T14:30:00Z' },
    ]);
    expect(frames[0].seriesMap.WALCL.at(-1)?.value).toBe(5800);
    expect(frames[0].seriesMap.SP500).toEqual([]);
    expect(frames[1].seriesMap.WALCL.at(-1)?.value).toBe(5900);
    expect(frames[0].seriesMap.WALCL.at(-1)?.value).toBe(5800);
    expect(frames[1].inputs).toHaveLength(SERIES_IDS.length);
    expect(new Set(frames[1].inputs.map(input => input.seriesId))).toEqual(new Set(SERIES_IDS));
    expect(frames[1].inputs.find(input => input.seriesId === 'SP500')).toMatchObject({ inputStatus: 'AVAILABLE' });
    expect(frames[1].inputs.find(input => input.seriesId === 'SOFR')).toEqual({
      seriesId: 'SOFR', inputStatus: 'MISSING', observationDate: null, vintageDate: null,
      releasedAt: null, fetchedAt: null, tradableAt: null, source: null, checksum: null,
      releaseTimeStatus: null, value: null,
    });
  });

  it('requires both release and tradability for execution', () => {
    expect(availableForExecution(row({}), '2024-01-05T00:00:00Z', '2024-01-05T14:29:59Z')).toBe(false);
    expect(availableForExecution(row({}), '2024-01-05T00:00:00Z', '2024-01-05T14:30:00Z')).toBe(true);
  });

  it('lifts the frame tradable time to the latest tradability of every row used by scoring history', () => {
    const frame = buildPitFrames([
      row({ observationDate: '2023-12-27', tradableAt: '2024-01-12T14:30:00Z' }),
      row({ observationDate: '2024-01-03', checksum: 'latest', tradableAt: '2024-01-05T14:30:00Z' }),
    ], [{
      modelDate: '2024-01-03', decisionAt: '2024-01-10T00:00:00Z', tradableAt: '2024-01-10T14:30:00Z',
    }])[0];
    expect(frame.event.tradableAt).toBe('2024-01-12T14:30:00Z');
  });

  it('computes dataCutoff from every scoring-history row, including a late revision of an older observation', () => {
    const frame = buildPitFrames([
      row({ observationDate: '2023-12-27', vintageDate: '2024-01-09', releasedAt: '2024-01-09T23:59:59Z' }),
      row({ observationDate: '2024-01-03', vintageDate: '2024-01-04', releasedAt: '2024-01-04T23:59:59Z', checksum: 'newer-endpoint' }),
    ], [{ modelDate: '2024-01-03', decisionAt: '2024-01-10T00:00:00Z', tradableAt: '2024-01-10T14:30:00Z' }])[0];
    expect(frame.inputs.find(input => input.seriesId === 'WALCL')).toMatchObject({
      observationDate: '2024-01-03', releasedAt: '2024-01-04T23:59:59Z',
    });
    expect(frame.dataCutoff).toBe('2024-01-09T23:59:59Z');
  });

  it('iterates production-scale frames lazily within a bounded budget', () => {
    const series = SERIES_IDS.slice(0, 12);
    const rows: PitObservation[] = [];
    for (const [seriesIndex, seriesId] of series.entries()) {
      for (let index = 0; index < 2500; index++) {
        const date = new Date(Date.UTC(2010, 0, 1 + index)).toISOString().slice(0, 10);
        rows.push(row({
          seriesId, observationDate: date, vintageDate: date,
          releasedAt: `${date}T00:00:00Z`, tradableAt: `${date}T14:30:00Z`,
          checksum: `${seriesIndex}-${index}`, value: index,
        }));
      }
    }
    const events = Array.from({ length: 500 }, (_, index) => {
      const date = new Date(Date.UTC(2010, 0, 1 + index * 5)).toISOString().slice(0, 10);
      return { modelDate: date, decisionAt: `${date}T23:59:59Z`, tradableAt: `${date}T23:59:59Z` };
    });
    const started = Date.now();
    const iterator = iteratePitFrames(rows, events);
    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(first.value?.event.modelDate).toBe(events[0].modelDate);
    let count = 1;
    while (!iterator.next().done) count++;
    expect(count).toBe(500);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 10_000);
});
