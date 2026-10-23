import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildRecoveryPlan, RECOVERY_SCENARIOS } from '../src/recovery-plan.mjs';

function git(cwd, args) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return res;
}

test('recovery-plan auto-detects accidental reset via reflog and recovers the lost commit onto a rescue branch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-recovery-reflog-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, '.gitignore'), '.env\n', 'utf8');
    writeFileSync(join(dir, 'feature.txt'), 'v1 baseline\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'commit 1: baseline']);

    git(dir, ['switch', '-c', 'feat/important-work']);
    writeFileSync(join(dir, 'feature.txt'), 'v2 valuable agent implementation\n', 'utf8');
    git(dir, ['commit', '-am', 'commit 2: valuable work']);
    const lostSha = git(dir, ['rev-parse', '--short', 'HEAD']).stdout.trim();

    // Simulate accidental destructive reset
    git(dir, ['reset', '--hard', 'HEAD~1']);
    assert.strictEqual(readFileSync(join(dir, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v1 baseline\n');

    const plan = buildRecoveryPlan(dir);
    assert.strictEqual(plan.scenario, 'accidental-reset');
    assert.strictEqual(plan.detectedAutomatically, true);
    assert.ok(plan.diagnosis.includes(lostSha), `Expected diagnosis to mention lost SHA ${lostSha}`);

    // Execute the exact recovery command recommended by the plan
    git(dir, ['switch', '-c', 'rescue/recovered-work', lostSha]);
    assert.strictEqual(readFileSync(join(dir, 'feature.txt'), 'utf8').replace(/\r\n/g, '\n'), 'v2 valuable agent implementation\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery-plan auto-detects bad merge on main and git revert -m 1 cleanly reverses it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-recovery-merge-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, '.gitignore'), '.env\n', 'utf8');
    writeFileSync(join(dir, 'auth.js'), 'export const guard = "strict";\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial strict guard']);

    git(dir, ['switch', '-c', 'feat/broken-agent']);
    writeFileSync(join(dir, 'auth.js'), 'export const guard = "broken";\n', 'utf8');
    git(dir, ['commit', '-am', 'agent broke guard']);

    git(dir, ['switch', 'main']);
    git(dir, ['merge', '--no-ff', 'feat/broken-agent', '-m', 'Merge branch feat/broken-agent']);
    assert.strictEqual(readFileSync(join(dir, 'auth.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const guard = "broken";\n');

    const plan = buildRecoveryPlan(dir);
    assert.strictEqual(plan.scenario, 'bad-merge-on-main');
    assert.ok(plan.steps.some((s) => s.command.startsWith('git revert -m 1')));

    // Execute git revert -m 1 HEAD --no-edit
    const revRes = git(dir, ['revert', '-m', '1', 'HEAD', '--no-edit']);
    assert.strictEqual(revRes.status, 0);
    assert.strictEqual(readFileSync(join(dir, 'auth.js'), 'utf8').replace(/\r\n/g, '\n'), 'export const guard = "strict";\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery-plan supports all 7 explicit scenarios and rejects unknown scenario names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-recovery-all-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'a.txt'), 'hello\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'init']);

    for (const scenario of RECOVERY_SCENARIOS) {
      const plan = buildRecoveryPlan(dir, { scenario });
      assert.strictEqual(plan.scenario, scenario);
      assert.strictEqual(plan.detectedAutomatically, false);
      assert.ok(plan.steps.length >= 2);
      assert.ok(plan.avoid.length >= 1);
    }

    assert.throws(() => buildRecoveryPlan(dir, { scenario: 'magic-fix-everything' }), /Unknown recovery scenario/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
