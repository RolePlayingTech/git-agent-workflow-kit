import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDoctor } from '../src/doctor.mjs';

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
  if (res.status !== 0 && !args.includes('merge')) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

test('doctor passes on a clean feature branch with .gitignore and remote', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-doctor-pass-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['remote', 'add', 'origin', 'https://example.com/repo.git']);
    writeFileSync(join(dir, '.gitignore'), '.env\n.env.*\n!.env.example\n', 'utf8');
    writeFileSync(join(dir, '.env.example'), 'API_URL=https://api.example.com\n', 'utf8');
    writeFileSync(join(dir, 'index.js'), 'export const ok = true;\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial commit']);
    git(dir, ['switch', '-c', 'feat/clean-branch']);

    const report = runDoctor(dir, { strict: true });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.status, 'PASS');
    assert.strictEqual(report.errors.length, 0);
    assert.strictEqual(report.warnings.length, 0);
    assert.strictEqual(report.repository.branch, 'feat/clean-branch');
    assert.strictEqual(report.workingTree.clean, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor warns on protected branch main and fails on untracked unignored .env without logging secret value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-doctor-env-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'app.js'), 'console.log(1);\n', 'utf8');
    git(dir, ['add', 'app.js']);
    git(dir, ['commit', '-m', 'init']);

    const secretValue = 'SUPER_SECRET_TOKEN_999111222';
    writeFileSync(join(dir, '.env.local'), `API_KEY=${secretValue}\n`, 'utf8');

    const report = runDoctor(dir);
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.status, 'FAIL');
    assert.strictEqual(report.repository.isProtectedBranch, true);
    assert.ok(report.errors.some((e) => e.includes('.env.local')));
    assert.ok(report.warnings.some((w) => w.includes('Active branch is "main"')));
    assert.ok(!JSON.stringify(report).includes(secretValue), 'Doctor output must never contain secret values');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor detects in-progress merge conflicts and detached HEAD state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-doctor-conflict-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, '.gitignore'), '.env\n', 'utf8');
    writeFileSync(join(dir, 'auth.js'), 'export const mode = "v1";\n', 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'base']);

    git(dir, ['switch', '-c', 'feat/a']);
    writeFileSync(join(dir, 'auth.js'), 'export const mode = "agent-a";\n', 'utf8');
    git(dir, ['commit', '-am', 'agent a']);

    git(dir, ['switch', '-c', 'feat/b', 'main']);
    writeFileSync(join(dir, 'auth.js'), 'export const mode = "agent-b";\n', 'utf8');
    git(dir, ['commit', '-am', 'agent b']);

    // Trigger conflict
    const mergeRes = git(dir, ['merge', 'feat/a']);
    assert.notStrictEqual(mergeRes.status, 0);

    const conflictReport = runDoctor(dir);
    assert.strictEqual(conflictReport.ok, false);
    assert.strictEqual(conflictReport.repository.inProgressOperation, 'merge');
    assert.strictEqual(conflictReport.workingTree.conflictedCount, 1);
    assert.strictEqual(conflictReport.workingTree.conflicted[0].path, 'auth.js');

    git(dir, ['merge', '--abort']);
    git(dir, ['checkout', '--detach', 'HEAD']);
    const detachedReport = runDoctor(dir);
    assert.strictEqual(detachedReport.repository.detached, true);
    assert.ok(detachedReport.warnings.some((w) => w.includes('detached HEAD')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor throws a clear error on non-git directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-not-a-repo-'));
  try {
    assert.throws(() => runDoctor(dir), /Not a Git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
