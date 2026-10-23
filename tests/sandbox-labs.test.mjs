import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSandbox } from '../src/sandbox.mjs';
import { runDoctor } from '../src/doctor.mjs';
import { runPrReady } from '../src/pr-ready.mjs';
import { buildRecoveryPlan } from '../src/recovery-plan.mjs';

function git(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Lab Learner',
      GIT_AUTHOR_EMAIL: 'learner@academy.mumro.io',
      GIT_COMMITTER_NAME: 'Lab Learner',
      GIT_COMMITTER_EMAIL: 'learner@academy.mumro.io',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
}

test('Lab A sandbox: full walkthrough from doctor failure to scoped PR readiness and merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-agent-lab-a-'));
  try {
    const target = join(root, 'lab-a');
    const sb = createSandbox('lab-a', target);
    const ws = sb.workspaceDir;

    // Step 1: Doctor catches main branch + unignored .env.local
    const doc1 = runDoctor(ws);
    assert.strictEqual(doc1.ok, false);
    assert.strictEqual(doc1.repository.branch, 'main');
    assert.ok(doc1.errors.some((e) => e.includes('.env.local')));

    // Step 2: Switch to feature branch and fix .gitignore
    assert.strictEqual(git(ws, ['switch', '-c', 'feat/session-expiry']).status, 0);
    writeFileSync(join(ws, '.gitignore'), 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n', 'utf8');

    // Step 3: Implement session expiry in src/auth.js + tests/auth.test.js, plus accidental edit to src/dashboard.js
    writeFileSync(
      join(ws, 'src/auth.js'),
      `export function verifySession(session) {
  if (!session || typeof session.userId !== 'string') {
    return { valid: false, reason: 'missing-user' };
  }
  if (typeof session.expiresAt === 'number' && typeof session.now === 'number' && session.now >= session.expiresAt) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, userId: session.userId };
}
`,
      'utf8'
    );
    writeFileSync(join(ws, 'src/dashboard.js'), '// Accidental out-of-scope agent edit\n', 'utf8');

    git(ws, ['add', '.gitignore', 'src/auth.js', 'src/dashboard.js']);
    git(ws, ['commit', '-m', 'feat: check session expiry (plus accidental dashboard edit)']);

    // Step 4: pr-ready catches out-of-scope src/dashboard.js
    const prFail = runPrReady(ws, {
      base: 'main',
      allow: ['src/auth.js', 'tests/auth.test.js', '.gitignore'],
    });
    assert.strictEqual(prFail.ok, false);
    assert.deepStrictEqual(prFail.scope.outOfScopeFiles, ['src/dashboard.js']);

    // Step 5: Restore src/dashboard.js from main and amend/commit
    assert.strictEqual(git(ws, ['restore', '--source=main', '--staged', '--worktree', 'src/dashboard.js']).status, 0);
    assert.strictEqual(git(ws, ['commit', '-m', 'chore: revert out-of-scope dashboard edit']).status, 0);

    const prPass = runPrReady(ws, {
      base: 'main',
      allow: ['src/auth.js', 'tests/auth.test.js', '.gitignore'],
      strict: true,
    });
    assert.strictEqual(prPass.ok, true);
    assert.strictEqual(prPass.status, 'PASS');

    // Step 6: Merge into main and push to local origin
    assert.strictEqual(git(ws, ['switch', 'main']).status, 0);
    assert.strictEqual(git(ws, ['merge', '--no-ff', 'feat/session-expiry', '-m', 'Merge PR: feat/session-expiry']).status, 0);
    assert.strictEqual(git(ws, ['push', 'origin', 'main']).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Lab B sandbox: three parallel agents, merge conflict resolution, weakened test detection, and safe revert', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-agent-lab-b-'));
  try {
    const target = join(root, 'lab-b');
    const sb = createSandbox('lab-b', target);
    const ws = sb.workspaceDir;

    // 1. Merge Agent 1 cleanly into main
    assert.strictEqual(git(ws, ['merge', 'agent-1/auth-audit']).status, 0);

    // 2. Merging Agent 2 causes a real conflict in src/auth.js
    const merge2 = git(ws, ['merge', 'agent-2/dashboard-cards']);
    assert.notStrictEqual(merge2.status, 0);

    const docConflict = runDoctor(ws);
    assert.strictEqual(docConflict.ok, false);
    assert.strictEqual(docConflict.repository.inProgressOperation, 'merge');
    assert.strictEqual(docConflict.workingTree.conflicted[0].path, 'src/auth.js');

    const planConflict = buildRecoveryPlan(ws);
    assert.strictEqual(planConflict.scenario, 'conflict-in-progress');

    // 3. Resolve conflict combining Agent 1 (auditedRole) and Agent 2 (header)
    writeFileSync(
      join(ws, 'src/auth.js'),
      `export function authorizeRequest(req) {
  const role = req?.user?.role ?? 'guest';
  const header = 'X-App-Auth: v2-unified';
  if (role !== 'admin' && role !== 'editor') {
    return { status: 403, allowed: false, header, auditedRole: role };
  }
  return { status: 200, allowed: true, header, auditedRole: role };
}
`,
      'utf8'
    );
    assert.strictEqual(git(ws, ['add', 'src/auth.js']).status, 0);
    assert.strictEqual(git(ws, ['commit', '-m', 'merge: combine agent-1 audit role and agent-2 dashboard cards']).status, 0);

    // 4. Audit Agent 3 branch before merging: pr-ready catches out-of-scope src/auth.js AND weakened test in tests/auth.test.js
    assert.strictEqual(git(ws, ['switch', 'agent-3/fix-tests']).status, 0);
    const prAgent3 = runPrReady(ws, { base: 'main', allow: ['tests/**'], strict: true });
    assert.strictEqual(prAgent3.ok, false);
    assert.deepStrictEqual(prAgent3.scope.outOfScopeFiles, ['src/auth.js']);
    assert.strictEqual(prAgent3.findings.testIntegrityFindings.length, 1);

    // 5. Simulate what happens if someone merged Agent 3 into main and then reverted the faulty merge with git revert -m 1
    assert.strictEqual(git(ws, ['switch', 'main']).status, 0);
    assert.strictEqual(
      git(ws, ['merge', '--no-ff', '-X', 'theirs', 'agent-3/fix-tests', '-m', 'Merge agent-3/fix-tests']).status,
      0
    );
    assert.ok(readFileSync(join(ws, 'src/auth.js'), 'utf8').includes("role === 'banned'"));

    const planBadMerge = buildRecoveryPlan(ws);
    assert.strictEqual(planBadMerge.scenario, 'bad-merge-on-main');

    assert.strictEqual(git(ws, ['revert', '-m', '1', 'HEAD', '--no-edit']).status, 0);
    assert.ok(readFileSync(join(ws, 'src/auth.js'), 'utf8').includes("role !== 'admin' && role !== 'editor'"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
