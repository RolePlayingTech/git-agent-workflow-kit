import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  applySkillsInstall,
  BUILTIN_SKILLS,
  listSkills,
  planSkillsInstall,
  validateSkillDefinition,
} from '../src/skills.mjs';
import { assertSafeChildPath, verifyManagedContent } from '../src/fs-safe.mjs';

test('all 5 built-in skills validate against Agent Skills naming and match canonical skills/*/SKILL.md files', () => {
  const listed = listSkills();
  assert.strictEqual(listed.length, 5);

  const repoRoot = resolve(import.meta.dirname, '..');
  for (const item of listed) {
    assert.match(item.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.strictEqual(item.sha256.length, 64);

    const diskPath = join(repoRoot, 'skills', item.name, 'SKILL.md');
    const diskContent = readFileSync(diskPath, 'utf8');
    const check = verifyManagedContent(diskContent);
    assert.strictEqual(check.managed, true);
    assert.strictEqual(check.valid, true);
    assert.strictEqual(check.digest, item.sha256);
  }

  // Regression check (#2): github-issue-to-pr must instruct committing before running post-commit pr-ready
  const issueToPrDisk = readFileSync(join(repoRoot, 'skills/github-issue-to-pr/SKILL.md'), 'utf8');
  const commitIdx = issueToPrDisk.indexOf('git commit -m');
  const prReadyIdx = issueToPrDisk.indexOf('git-agent-workflow-kit pr-ready');
  assert.ok(commitIdx > 0 && prReadyIdx > commitIdx, 'github-issue-to-pr skill must commit before running pr-ready');
  assert.match(issueToPrDisk, /git diff --cached/);
});

test('skills install tracks create, unchanged, and conflict states and refuses to overwrite hand-edited skills without --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-skills-'));
  try {
    // 1. Initial install creates 5 files
    const planCreate = planSkillsInstall(dir, { target: 'claude' });
    assert.strictEqual(planCreate.counts.create, 5);
    assert.strictEqual(planCreate.counts.conflict, 0);
    applySkillsInstall(planCreate);

    // 2. Re-running is idempotent (unchanged: 5)
    const planUnchanged = planSkillsInstall(dir, { target: 'claude' });
    assert.strictEqual(planUnchanged.counts.unchanged, 5);
    assert.strictEqual(planUnchanged.counts.create, 0);

    // 3. Hand-edit one skill -> conflict detected
    const editedPath = join(dir, '.claude/skills/git-repo-onboarding/SKILL.md');
    writeFileSync(editedPath, `${readFileSync(editedPath, 'utf8')}\n# Hand edit\n`, 'utf8');

    const planConflict = planSkillsInstall(dir, { target: 'claude' });
    assert.strictEqual(planConflict.counts.conflict, 1);
    assert.strictEqual(planConflict.counts.unchanged, 4);
    assert.throws(() => applySkillsInstall(planConflict), /Refusing to overwrite 1 conflicting skill/);

    // 4. --force resolves the conflict
    const planForce = planSkillsInstall(dir, { target: 'claude', force: true });
    assert.strictEqual(planForce.counts.update, 1);
    assert.strictEqual(planForce.counts.conflict, 0);
    applySkillsInstall(planForce, { force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateSkillDefinition and assertSafeChildPath reject invalid names and path traversal', () => {
  assert.throws(
    () => validateSkillDefinition({ name: 'Bad_Name', description: 'Use when testing.' }),
    /Invalid skill name/
  );
  assert.throws(
    () => validateSkillDefinition({ name: 'valid-name', description: 'Missing trigger clause.' }),
    /must include a "Use when \.\.\." trigger clause/
  );

  const dir = mkdtempSync(join(tmpdir(), 'git-agent-pathsafe-'));
  try {
    assert.throws(() => assertSafeChildPath(dir, '../escape/SKILL.md'), /Path traversal/);
    assert.throws(() => assertSafeChildPath(dir, '/abs/path/SKILL.md'), /must be relative/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
