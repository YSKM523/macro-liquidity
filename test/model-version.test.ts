import { describe, expect, it } from 'vitest';
// @ts-ignore Vitest executes in Node.
import { readFileSync } from 'node:fs';
import {
  CHAMPION_MODEL_VERSION,
  canonicalChampionConfig,
  resolveModelIdentity,
  validateCommitSha,
} from '../src/model-version';

describe('Champion model identity', () => {
  it('canonicalizes deterministically and produces a SHA-256 config hash', async () => {
    const first = await resolveModelIdentity({ CODE_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' });
    const second = await resolveModelIdentity({ CODE_COMMIT_SHA: '0123456789abcdef0123456789abcdef01234567' });

    expect(canonicalChampionConfig()).toBe(canonicalChampionConfig());
    expect(first).toEqual(second);
    expect(first.modelVersion).toBe(CHAMPION_MODEL_VERSION);
    expect(first.configHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.codeCommitSha).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  it('never impersonates a commit when the deployment binding is absent or malformed', async () => {
    expect(validateCommitSha(undefined)).toBe('LOCAL_UNCONFIGURED');
    expect(validateCommitSha('main')).toBe('LOCAL_UNCONFIGURED');
    await expect(resolveModelIdentity({ CODE_COMMIT_SHA: 'main' })).resolves.toMatchObject({
      codeCommitSha: 'LOCAL_UNCONFIGURED',
    });
  });

  it('adds and conservatively backfills the complete snapshot identity contract', () => {
    const sql = readFileSync('migrations/0010_model_governance.sql', 'utf8');
    for (const table of ['model_snapshot_weekly', 'nowcast_snapshot_daily']) {
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN model_version`);
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN config_hash`);
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN code_commit_sha`);
      expect(sql).toContain(`ALTER TABLE ${table} ADD COLUMN created_at`);
      expect(sql).toMatch(new RegExp(`UPDATE ${table}[^;]+LEGACY_UNVERSIONED`, 's'));
    }
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS admin_audit_log');
  });
});
