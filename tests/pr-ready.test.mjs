import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runPrReady } from '../src/pr-ready.mjs';

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
