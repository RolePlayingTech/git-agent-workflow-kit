import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPrReady } from '../src/pr-ready.mjs';
import { sanitizeGitError } from '../src/git.mjs';

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
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res;
}

test('pr-ready passes on a clean, scoped feature branch and fails on out-of-scope edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-pr-scope-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'src/auth.js'), 'export const timeout = 30;\n', 'utf8');
    writeFileSync(join(dir, 'src/dashboard.js'), 'export const cards = 3;\n', 'utf8');
    writeFileSync(
      join(dir, 'tests/auth.test.js'),
      'import assert from "node:assert/strict";\nassert.strictEqual(30, 30);\n',
      'utf8'
    );
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'initial']);

    git(dir, ['switch', '-c', 'feat/auth-timeout']);
    writeFileSync(join(dir, 'src/auth.js'), 'export const timeout = 60;\n', 'utf8');
    writeFileSync(
      join(dir, 'tests/auth.test.js'),
      'import assert from "node:assert/strict";\nassert.strictEqual(60, 60);\n',
      'utf8'
    );
    git(dir, ['commit', '-am', 'feat: update timeout to 60']);

    const passReport = runPrReady(dir, {
      base: 'main',
      allow: ['src/auth.js', 'tests/**'],
      strict: true,
    });
    assert.strictEqual(passReport.ok, true);
    assert.strictEqual(passReport.status, 'PASS');
    assert.strictEqual(passReport.commitsAhead, 1);
    assert.strictEqual(passReport.scope.outOfScopeFiles.length, 0);

    // Now touch out-of-scope file src/dashboard.js
    writeFileSync(join(dir, 'src/dashboard.js'), 'export const cards = 99;\n', 'utf8');
    git(dir, ['commit', '-am', 'unrelated dashboard edit']);

    const failScope = runPrReady(dir, {
      base: 'main',
      allow: ['src/auth.js', 'tests/**'],
    });
    assert.strictEqual(failScope.ok, false);
    assert.deepStrictEqual(failScope.scope.outOfScopeFiles, ['src/dashboard.js']);
    assert.ok(failScope.errors.some((e) => e.includes('Out-of-scope file modified: "src/dashboard.js"')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pr-ready detects weakened test assertions and governance file modifications', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-pr-weaktest-'));
  try {
    git(dir, ['init', '--initial-branch=main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents\n', 'utf8');
    writeFileSync(
      join(dir, 'tests/auth.spec.js'),
      'expect(res.status).toBe(403);\nexpect(res.allowed).toBe(false);\n',
      'utf8'
    );
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', 'base']);

    git(dir, ['switch', '-c', 'fix/greenwash-tests']);
    writeFileSync(join(dir, 'AGENTS.md'), '# Agents modified\n', 'utf8');
    writeFileSync(join(dir, 'tests/auth.spec.js'), 'expect(res.status).toBeDefined();\n', 'utf8');
    git(dir, ['commit', '-am', 'make tests green']);

    const report = runPrReady(dir, { base: 'main', strict: true });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.findings.testIntegrityFindings.length, 1);
    assert.strictEqual(report.findings.governanceFilesInDiff.length, 1);
    assert.ok(report.warnings.some((w) => w.includes('Suspicious test modification in "tests/auth.spec.js"')));
    assert.ok(report.warnings.some((w) => w.includes('AGENTS.md')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pr-ready fails closed on unrelated root histories (--orphan) and never reports a false-positive PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-agent-unrelated-'));
  const cliBin = resolve(import.meta.dirname, '../bin/git-agent.mjs');
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    git(dir, ['commit', '--allow-empty', '-m', 'base']);

    git(dir, ['switch', '--orphan', 'feature']);
    writeFileSync(join(dir, 'unrelated.txt'), 'new file\n', 'utf8');
    git(dir, ['add', 'unrelated.txt']);
    git(dir, ['commit', '-m', 'feature on orphan root']);

    const report = runPrReady(dir, { base: 'main', strict: true });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.status, 'FAIL');
    assert.strictEqual(report.mergeBase, null);
    assert.ok(report.errors.some((e) => e.includes('Cannot compute merge base between "main" and HEAD')));
    assert.ok(report.errors.some((e) => e.includes('Failed to compute changed file statuses')));
    assert.ok(report.errors.some((e) => e.includes('Failed to compute diff line stats')));
    assert.ok(report.errors.some((e) => e.includes('Failed to scan diff for conflict markers')));

    // Verify CLI binary exits 1 and prints FAIL
    const cliRes = spawnSync(process.execPath, [cliBin, 'pr-ready', dir, '--base', 'main', '--strict'], {
      encoding: 'utf8',
    });
    assert.strictEqual(cliRes.status, 1);
    assert.match(cliRes.stdout, /^Git Agent PR Readiness: FAIL/m);
    assert.match(cliRes.stdout, /Cannot compute merge base between "main" and HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pr-ready fails closed on missing base ref, shallow clones without merge base, and staged uncommitted changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-agent-shallow-'));
  try {
    const originDir = join(root, 'origin.git');
    const setupDir = join(root, 'setup');
    const shallowDir = join(root, 'shallow');

    git(root, ['init', '--bare', '--initial-branch=main', originDir]);
    git(root, ['clone', originDir, setupDir]);
    git(setupDir, ['config', 'commit.gpgsign', 'false']);

    writeFileSync(join(setupDir, 'file.txt'), 'v1\n', 'utf8');
    git(setupDir, ['add', 'file.txt']);
    git(setupDir, ['commit', '-m', 'c1']);
    writeFileSync(join(setupDir, 'file.txt'), 'v2\n', 'utf8');
    git(setupDir, ['commit', '-am', 'c2']);
    writeFileSync(join(setupDir, 'file.txt'), 'v3\n', 'utf8');
    git(setupDir, ['commit', '-am', 'c3']);
    git(setupDir, ['push', '-u', 'origin', 'main']);

    git(setupDir, ['switch', '-c', 'feat/diverged', 'HEAD~2']);
    writeFileSync(join(setupDir, 'feat.txt'), 'feature\n', 'utf8');
    git(setupDir, ['add', 'feat.txt']);
    git(setupDir, ['commit', '-m', 'f1']);
    writeFileSync(join(setupDir, 'feat.txt'), 'feature2\n', 'utf8');
    git(setupDir, ['commit', '-am', 'f2']);
    git(setupDir, ['push', '-u', 'origin', 'feat/diverged']);

    // 1. Invalid base ref throws clear error
    assert.throws(() => runPrReady(setupDir, { base: 'nonexistent-base-ref' }), /could not be resolved/);

    // 2. Staged uncommitted changes fail closed before commit
    writeFileSync(join(setupDir, 'feat.txt'), 'staged-but-uncommitted\n', 'utf8');
    git(setupDir, ['add', 'feat.txt']);
    const stagedReport = runPrReady(setupDir, { base: 'main' });
    assert.strictEqual(stagedReport.ok, false);
    assert.ok(stagedReport.errors.some((e) => e.includes('Working tree has uncommitted changes (staged: 1, unstaged: 0)')));

    // 3. Shallow clone with depth=1 where main and feat/diverged have no merge base in shallow graph
    const fileUrl = `file://${originDir.replace(/\\/g, '/')}`;
    git(root, ['clone', '--depth', '1', '--branch', 'feat/diverged', fileUrl, shallowDir]);
    git(shallowDir, ['remote', 'set-branches', 'origin', 'main', 'feat/diverged']);
    git(shallowDir, ['fetch', '--depth', '1', 'origin', 'main']);

    const shallowReport = runPrReady(shallowDir, { base: 'origin/main', strict: true });
    assert.strictEqual(shallowReport.ok, false);
    assert.strictEqual(shallowReport.status, 'FAIL');
    assert.ok(shallowReport.errors.some((e) => e.includes('Cannot compute merge base between "origin/main" and HEAD')));

    // 4. Verify credential sanitization helper strips tokens from error strings
    assert.strictEqual(
      sanitizeGitError('fatal: unable to access https://user:ghp_secretToken12345@github.com/org/repo.git/'),
      'fatal: unable to access https://***:***@github.com/org/repo.git/'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
