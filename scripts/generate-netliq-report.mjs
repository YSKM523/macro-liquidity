#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderNetLiquidityReport } from './netliq-report.mjs';
import { runNetLiquidityResearch } from './run-netliq-research.mjs';

const snapshotId = 'netliq-current-vintage-2026-07-22-corrected-v2';
const snapshotPath = resolve(`scripts/data/${snapshotId}.json`);
const manifestPath = resolve(`scripts/data/${snapshotId}.manifest.json`);
const snapshotText = await readFile(snapshotPath, 'utf8');
const snapshot = JSON.parse(snapshotText);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const report = await runNetLiquidityResearch(snapshot, snapshotText, manifest);

const jsonPath = resolve('docs/research/NETLIQ_CHALLENGER_OOS_REPORT.json');
const markdownPath = resolve('docs/research/NETLIQ_CHALLENGER_OOS_REPORT.md');
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
await writeFile(markdownPath, `${renderNetLiquidityReport(report)}\n`, { encoding: 'utf8', flag: 'wx' });

console.log(JSON.stringify({
  jsonPath,
  markdownPath,
  raw: report.oos.raw,
  smooth: report.oos.smooth,
  agreementConfirmed: report.oos.agreementConfirmed,
  agreement: report.oos.agreement,
  decision: report.decision,
}, null, 2));
