import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSafeChildPath } from './fs-safe.mjs';

function runGitSetup(cwd, args, timestamp = '2026-10-20T10:00:00Z') {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MUMRO Academy Sandbox',
      GIT_AUTHOR_EMAIL: 'sandbox@academy.mumro.io',
      GIT_COMMITTER_NAME: 'MUMRO Academy Sandbox',
      GIT_COMMITTER_EMAIL: 'sandbox@academy.mumro.io',
      GIT_AUTHOR_DATE: timestamp,
      GIT_COMMITTER_DATE: timestamp,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    },
  });
  if (res.status !== 0) {
    throw new Error(`Sandbox git ${args.join(' ')} failed in ${cwd}: ${res.stderr || res.stdout}`);
  }
  return (res.stdout || '').trim();
}

function writeRepoFile(rootDir, relPath, content) {
  const safe = assertSafeChildPath(rootDir, relPath);
  const parent = resolve(safe.fullPath, '..');
  mkdirSync(parent, { recursive: true });
  writeFileSync(safe.fullPath, content.replace(/\r\n/g, '\n'), 'utf8');
}

export function createSandbox(labId, targetDir) {
  if (labId !== 'lab-a' && labId !== 'lab-b') {
    throw new Error(`Unknown sandbox template "${labId}". Supported templates: lab-a, lab-b`);
  }

  const root = resolve(targetDir);
  if (existsSync(root)) {
    const entries = readdirSync(root);
    if (entries.length > 0) {
      throw new Error(`Target sandbox directory "${root}" already exists and is not empty.`);
    }
  } else {
    mkdirSync(root, { recursive: true });
  }

  const originDir = join(root, 'origin.git');
  const workspaceDir = join(root, 'workspace');
  mkdirSync(originDir, { recursive: true });

  runGitSetup(originDir, ['init', '--bare', '--initial-branch=main']);
  runGitSetup(root, ['clone', originDir, workspaceDir]);
  runGitSetup(workspaceDir, ['config', 'user.name', 'MUMRO Academy Learner']);
  runGitSetup(workspaceDir, ['config', 'user.email', 'learner@academy.mumro.io']);
  runGitSetup(workspaceDir, ['config', 'commit.gpgsign', 'false']);
  runGitSetup(workspaceDir, ['config', 'core.autocrlf', 'false']);

  if (labId === 'lab-a') {
    writeRepoFile(
      workspaceDir,
      'package.json',
      `${JSON.stringify(
        {
          name: 'pulse-notes-lab-a',
          version: '1.0.0',
          private: true,
          type: 'module',
          scripts: {
            test: 'node --test tests/auth.test.js',
          },
        },
        null,
        2
      )}\n`
    );

    // Deliberately incomplete .gitignore (missing .env / .env.*) for Lab A Step 1
    writeRepoFile(workspaceDir, '.gitignore', 'node_modules/\ndist/\n');

    writeRepoFile(
      workspaceDir,
      'src/auth.js',
      `export function verifySession(session) {
  if (!session || typeof session.userId !== 'string') {
    return { valid: false, reason: 'missing-user' };
  }
  return { valid: true, userId: session.userId };
}
`
    );

    writeRepoFile(
      workspaceDir,
      'src/dashboard.js',
      `export function formatDashboardHeader(workspaceName) {
  return \`Workspace: \${workspaceName}\`;
}
`
    );

    writeRepoFile(
      workspaceDir,
      'tests/auth.test.js',
      `import test from 'node:test';
import assert from 'node:assert/strict';
import { verifySession } from '../src/auth.js';

test('accepts session with userId', () => {
  const res = verifySession({ userId: 'usr_01', expiresAt: 2000, now: 1000 });
  assert.strictEqual(res.valid, true);
});
`
    );

    runGitSetup(workspaceDir, ['add', '.'], '2026-10-20T10:00:00Z');
    runGitSetup(workspaceDir, ['commit', '-m', 'feat: initial session verifier and dashboard header'], '2026-10-20T10:00:00Z');
    runGitSetup(workspaceDir, ['push', '-u', 'origin', 'main'], '2026-10-20T10:00:00Z');

    // Leave an untracked .env.local file in workspace so `git-agent doctor` flags it immediately
    writeRepoFile(workspaceDir, '.env.local', 'SESSION_HMAC_SECRET=local-dev-placeholder-do-not-commit\n');

    return {
      lab: 'lab-a',
      rootDir: root,
      originDir,
      workspaceDir,
      branches: ['main'],
      instructions: [
        `cd "${workspaceDir}"`,
        'npx github:RolePlayingTech/git-agent-workflow-kit doctor .',
        'git switch -c feat/session-expiry',
        'npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base main --allow "src/auth.js" --allow "tests/auth.test.js" --allow ".gitignore"',
      ],
    };
  }

  // Lab B: Three parallel AI agents, merge conflict, weakened test & safe revert
  writeRepoFile(
    workspaceDir,
    'package.json',
    `${JSON.stringify(
      {
        name: 'pulse-notes-lab-b',
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          test: 'node --test tests/auth.test.js',
        },
      },
      null,
      2
    )}\n`
  );

  writeRepoFile(workspaceDir, '.gitignore', 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n');

  writeRepoFile(
    workspaceDir,
    'src/auth.js',
    `export function authorizeRequest(req) {
  const role = req?.user?.role ?? 'guest';
  const header = 'X-App-Auth: v1';
  if (role !== 'admin' && role !== 'editor') {
    return { status: 403, allowed: false, header };
  }
  return { status: 200, allowed: true, header };
}
`
  );

  writeRepoFile(
    workspaceDir,
    'src/dashboard.js',
    `export function buildDashboardSummary(stats) {
  return {
    title: 'Campaign Overview',
    activeCount: stats?.active ?? 0,
  };
}
`
  );

  writeRepoFile(
    workspaceDir,
    'tests/auth.test.js',
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../src/auth.js';

test('blocks guest role with HTTP 403', () => {
  const res = authorizeRequest({ user: { role: 'guest' } });
  assert.strictEqual(res.status, 403);
  assert.strictEqual(res.allowed, false);
});

test('allows admin role with HTTP 200', () => {
  const res = authorizeRequest({ user: { role: 'admin' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.allowed, true);
});
`
  );

  runGitSetup(workspaceDir, ['add', '.'], '2026-10-20T10:00:00Z');
  runGitSetup(workspaceDir, ['commit', '-m', 'feat: baseline role guard and dashboard summary'], '2026-10-20T10:00:00Z');
  runGitSetup(workspaceDir, ['push', '-u', 'origin', 'main'], '2026-10-20T10:00:00Z');

  // Agent 1 branch: modifies auth header and adds auditRole
  runGitSetup(workspaceDir, ['switch', '-c', 'agent-1/auth-audit', 'main'], '2026-10-20T10:05:00Z');
  writeRepoFile(
    workspaceDir,
    'src/auth.js',
    `export function authorizeRequest(req) {
  const role = req?.user?.role ?? 'guest';
  const header = 'X-App-Auth: v2-audit';
  if (role !== 'admin' && role !== 'editor') {
    return { status: 403, allowed: false, header, auditedRole: role };
  }
  return { status: 200, allowed: true, header, auditedRole: role };
}
`
  );
  runGitSetup(workspaceDir, ['add', 'src/auth.js'], '2026-10-20T10:05:00Z');
  runGitSetup(workspaceDir, ['commit', '-m', 'feat(auth): include auditedRole and v2-audit header'], '2026-10-20T10:05:00Z');
  runGitSetup(workspaceDir, ['push', '-u', 'origin', 'agent-1/auth-audit'], '2026-10-20T10:05:00Z');

  // Agent 2 branch: branched from main, updates dashboard.js AND touches the same lines in src/auth.js
  runGitSetup(workspaceDir, ['switch', '-c', 'agent-2/dashboard-cards', 'main'], '2026-10-20T10:10:00Z');
  writeRepoFile(
    workspaceDir,
    'src/auth.js',
    `export function authorizeRequest(req) {
  const role = req?.user?.role ?? 'guest';
  const header = 'X-App-Auth: v2-dashboard';
  if (role !== 'admin' && role !== 'editor') {
    return { status: 403, allowed: false, header };
  }
  return { status: 200, allowed: true, header };
}
`
  );
  writeRepoFile(
    workspaceDir,
    'src/dashboard.js',
    `export function buildDashboardSummary(stats) {
  return {
    title: 'Campaign Overview',
    activeCount: stats?.active ?? 0,
    conversionRate: stats?.conversions ?? 0,
  };
}
`
  );
  runGitSetup(workspaceDir, ['add', 'src/auth.js', 'src/dashboard.js'], '2026-10-20T10:10:00Z');
  runGitSetup(workspaceDir, ['commit', '-m', 'feat(dashboard): add conversionRate and dashboard auth header'], '2026-10-20T10:10:00Z');
  runGitSetup(workspaceDir, ['push', '-u', 'origin', 'agent-2/dashboard-cards'], '2026-10-20T10:10:00Z');

  // Agent 3 branch: claims "fixed tests", but weakened tests/auth.test.js and broke role check in src/auth.js
  runGitSetup(workspaceDir, ['switch', '-c', 'agent-3/fix-tests', 'main'], '2026-10-20T10:15:00Z');
  writeRepoFile(
    workspaceDir,
    'src/auth.js',
    `export function authorizeRequest(req) {
  const role = req?.user?.role ?? 'guest';
  const header = 'X-App-Auth: v1';
  if (role === 'banned') {
    return { status: 403, allowed: false, header };
  }
  return { status: 200, allowed: true, header };
}
`
  );
  writeRepoFile(
    workspaceDir,
    'tests/auth.test.js',
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeRequest } from '../src/auth.js';

test('blocks guest role with HTTP 403', () => {
  const res = authorizeRequest({ user: { role: 'guest' } });
  assert.ok(res.status);
});

test('allows admin role with HTTP 200', () => {
  const res = authorizeRequest({ user: { role: 'admin' } });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.allowed, true);
});
`
  );
  runGitSetup(workspaceDir, ['add', 'src/auth.js', 'tests/auth.test.js'], '2026-10-20T10:15:00Z');
  runGitSetup(workspaceDir, ['commit', '-m', 'test(auth): make all auth tests pass'], '2026-10-20T10:15:00Z');
  runGitSetup(workspaceDir, ['push', '-u', 'origin', 'agent-3/fix-tests'], '2026-10-20T10:15:00Z');

  // Return workspace to main
  runGitSetup(workspaceDir, ['switch', 'main'], '2026-10-20T10:20:00Z');

  return {
    lab: 'lab-b',
    rootDir: root,
    originDir,
    workspaceDir,
    branches: ['main', 'agent-1/auth-audit', 'agent-2/dashboard-cards', 'agent-3/fix-tests'],
    instructions: [
      `cd "${workspaceDir}"`,
      'git branch -a',
      'git switch agent-3/fix-tests',
      'npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base main --allow "tests/**" --strict',
    ],
  };
}
