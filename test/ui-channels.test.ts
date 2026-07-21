import { describe, expect, it } from 'vitest';
// The project tsconfig intentionally only loads Workers types; this test runs in Vitest's Node runtime.
// @ts-ignore
import { readFileSync } from 'node:fs';

describe('snapshot channel UI', () => {
  it('visibly labels the official signal and provisional intra-week estimate', () => {
    const html = readFileSync('public/index.html', 'utf8');
    const app = readFileSync('public/app.js', 'utf8');

    expect(html).toContain('正式信号');
    expect(html).toContain('周中预估');
    expect(html).toContain('PROVISIONAL');
    expect(app).toContain('snapRes.official');
    expect(app).toContain('snapRes.nowcast');
  });
});
