import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export const PROTECTED_BRANCH_NAMES = new Set(['main', 'master', 'production', 'prod', 'trunk', 'release']);

const SAFE_ENV_TEMPLATE_NAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.defaults',
  '.env.schema',
]);

export function runGit(cwd, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    },
    timeout: options.timeoutMs ?? 15000,
  });

  if (result.error) {
    throw new Error(`Failed to execute git: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout || '').replace(/\r\n/g, '\n'),
    stderr: (result.stderr || '').replace(/\r\n/g, '\n'),
  };
}

export function sanitizeGitError(rawText) {
  if (!rawText) return '';
  return String(rawText)
    .replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://***:***@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+)\b/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

export function classifySensitivePath(relPath) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = basename(normalized);
  const lowerBase = base.toLowerCase();

  if (SAFE_ENV_TEMPLATE_NAMES.has(lowerBase)) {
    return null;
  }
  if (lowerBase === '.env' || lowerBase.startsWith('.env.')) {
    return { path: normalized, category: 'dotenv-secret-file', reason: 'Environment file may contain live secrets or API keys' };
  }
  if (/\.(pem|key|p12|pfx|keystore)$/i.test(lowerBase)) {
    return { path: normalized, category: 'private-key-file', reason: 'Private key or certificate archive' };
  }
  if (/^(id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(lowerBase)) {
    return { path: normalized, category: 'ssh-private-key', reason: 'SSH private key file' };
  }
  if (/^(credentials\.json|service-account.*\.json|\.npmrc|\.pypirc)$/i.test(lowerBase)) {
    return { path: normalized, category: 'credential-config', reason: 'Credential or registry token configuration file' };
  }
  return null;
}

export function classifyGovernanceOrRiskPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^\.github\/workflows\//.test(normalized) || /^\.gitlab-ci\.yml$/.test(normalized)) {
    return { path: normalized, category: 'ci-workflow', reason: 'CI/CD pipeline workflow modified' };
  }
  if (/(^|\/)(migrations|prisma\/migrations)\//.test(normalized) || /schema\.prisma$/.test(normalized)) {
    return { path: normalized, category: 'db-migration', reason: 'Database schema or migration modified' };
  }
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock)$/.test(normalized)) {
    return { path: normalized, category: 'dependency-lockfile', reason: 'Dependency lockfile modified' };
  }
  if (/(^|\/)(AGENTS\.md|CLAUDE\.md|CODEOWNERS|\.harness\/spec\.json|\.mcp-surface\/spec\.json)$/.test(normalized)) {
    return { path: normalized, category: 'agent-governance', reason: 'Repository governance or agent harness file modified' };
  }
  return null;
}

export function detectInProgressOperation(gitDir) {
  const checks = [
    { file: 'MERGE_HEAD', operation: 'merge', abortCmd: 'git merge --abort' },
    { file: 'REBASE_MERGE', operation: 'rebase', abortCmd: 'git rebase --abort' },
    { file: 'rebase-merge', operation: 'rebase', abortCmd: 'git rebase --abort' },
    { file: 'REBASE_APPLY', operation: 'rebase', abortCmd: 'git rebase --abort' },
    { file: 'rebase-apply', operation: 'rebase', abortCmd: 'git rebase --abort' },
    { file: 'CHERRY_PICK_HEAD', operation: 'cherry-pick', abortCmd: 'git cherry-pick --abort' },
    { file: 'REVERT_HEAD', operation: 'revert', abortCmd: 'git revert --abort' },
    { file: 'BISECT_LOG', operation: 'bisect', abortCmd: 'git bisect reset' },
  ];
  for (const item of checks) {
    if (existsSync(join(gitDir, item.file))) {
      return { operation: item.operation, marker: item.file, abortCommand: item.abortCmd };
    }
  }
  return null;
}

export function parseStatusPorcelain(statusOutput) {
  const lines = statusOutput.split('\n').filter((line) => line.length > 0);
  let branchHeader = '';
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];

  const conflictCodes = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

  for (const line of lines) {
    if (line.startsWith('## ')) {
      branchHeader = line.slice(3).trim();
      continue;
    }
    const xy = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    const path = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop().trim() : rawPath;

    if (xy === '??') {
      untracked.push(path);
      continue;
    }
    if (conflictCodes.has(xy)) {
      conflicted.push({ code: xy, path });
      continue;
    }
    const x = xy[0];
    const y = xy[1];
    if (x !== ' ' && x !== '?') {
      staged.push({ status: x, path });
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push({ status: y, path });
    }
  }

  return { branchHeader, staged, unstaged, untracked, conflicted };
}

export function listWorktrees(cwd) {
  const res = runGit(cwd, ['worktree', 'list', '--porcelain']);
  if (res.status !== 0) return [];
  const entries = [];
  let current = null;
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = { path: line.slice('worktree '.length).trim(), head: null, branch: null, bare: false, detached: false };
    } else if (current && line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (current && line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (current && line === 'bare') {
      current.bare = true;
    } else if (current && line === 'detached') {
      current.detached = true;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export function inspectRepoContext(dir) {
  const targetDir = resolve(dir);
  if (!existsSync(targetDir)) {
    throw new Error(`Directory does not exist: ${targetDir}`);
  }
  const topRes = runGit(targetDir, ['rev-parse', '--show-toplevel', '--git-dir']);
  if (topRes.status !== 0) {
    throw new Error(`Not a Git repository: ${targetDir}`);
  }
  const [repoRootRaw, gitDirRaw] = topRes.stdout.trim().split('\n');
  const repoRoot = resolve(targetDir, repoRootRaw);
  const gitDir = resolve(targetDir, gitDirRaw);

  const headRefRes = runGit(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const detached = headRefRes.status !== 0;
  const branch = detached ? null : headRefRes.stdout.trim();

  const shaRes = runGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
  const hasCommits = shaRes.status === 0;
  const headSha = hasCommits ? shaRes.stdout.trim() : null;

  const statusRes = runGit(repoRoot, ['status', '--porcelain=v1', '-b', '-uall']);
  const status = parseStatusPorcelain(statusRes.stdout);

  const inProgress = detectInProgressOperation(gitDir);
  const worktrees = listWorktrees(repoRoot);

  const remotesRes = runGit(repoRoot, ['remote']);
  const remotes = remotesRes.status === 0 ? remotesRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];

  const upstreamRes = branch
    ? runGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    : { status: 1, stdout: '' };
  const upstream = upstreamRes.status === 0 ? upstreamRes.stdout.trim() : null;

  return {
    repoRoot,
    gitDir,
    branch,
    detached,
    hasCommits,
    headSha,
    isProtectedBranch: Boolean(branch && PROTECTED_BRANCH_NAMES.has(branch)),
    status,
    inProgress,
    worktrees,
    remotes,
    upstream,
  };
}
