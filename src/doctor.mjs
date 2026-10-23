import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifySensitivePath, inspectRepoContext, runGit } from './git.mjs';

export function runDoctor(dir, options = {}) {
  const ctx = inspectRepoContext(dir);
  const errors = [];
  const warnings = [];
  const recommendations = [];

  // 1. In-progress operation check
  if (ctx.inProgress) {
    errors.push(
      `In-progress Git ${ctx.inProgress.operation} detected (${ctx.inProgress.marker}). Complete it or abort safely with "${ctx.inProgress.abortCommand}".`
    );
    recommendations.push(`Run "git-agent recovery-plan" or "${ctx.inProgress.abortCommand}" before starting new edits.`);
  }

  // 2. Unresolved merge conflicts
  if (ctx.status.conflicted.length > 0) {
    const list = ctx.status.conflicted.map((c) => `${c.code} ${c.path}`).join(', ');
    errors.push(`Unresolved merge conflicts (${ctx.status.conflicted.length}): ${list}`);
    recommendations.push('Resolve conflicted files, verify tests, then stage with "git add <file>" (or abort the merge/rebase).');
  }

  // 3. Leftover conflict markers in tracked files
  if (ctx.hasCommits) {
    const markerGrep = runGit(ctx.repoRoot, ['grep', '-n', '-I', '-E', '^(<{7} |>{7} )']);
    if (markerGrep.status === 0 && markerGrep.stdout.trim()) {
      const hits = markerGrep.stdout
        .trim()
        .split('\n')
        .slice(0, 5)
        .map((line) => line.split(':').slice(0, 2).join(':'));
      errors.push(`Leftover conflict markers found in tracked files: ${hits.join(', ')}`);
    }
  }

  // 4. Branch & HEAD safety
  if (!ctx.hasCommits) {
    warnings.push('Repository has no commits yet (unborn HEAD).');
  } else if (ctx.detached) {
    warnings.push(
      `Repository is in detached HEAD state at ${ctx.headSha}. Commits made here can become orphaned if you switch branches.`
    );
    recommendations.push('Attach a branch before committing: "git switch -c feat/<task-name>".');
  } else if (ctx.isProtectedBranch) {
    warnings.push(
      `Active branch is "${ctx.branch}" (shared/default branch). Coding agents should work on an isolated feature branch or worktree.`
    );
    recommendations.push('Create a task branch first: "git switch -c feat/<task-name>".');
  }

  // 5. Working tree dirtiness
  const dirtyCount = ctx.status.staged.length + ctx.status.unstaged.length + ctx.status.untracked.length;
  if (dirtyCount > 0) {
    warnings.push(
      `Working tree is not clean (staged: ${ctx.status.staged.length}, unstaged: ${ctx.status.unstaged.length}, untracked: ${ctx.status.untracked.length}).`
    );
    if (ctx.isProtectedBranch) {
      recommendations.push(
        'Move uncommitted work off the default branch with "git switch -c feat/<task-name>" or shelve it with "git stash push -u -m \\"wip\\"".'
      );
    }
  }

  // 6. Secret & .gitignore hygiene (never reads or prints secret values)
  const trackedRes = runGit(ctx.repoRoot, ['ls-files']);
  const trackedFiles = trackedRes.status === 0 ? trackedRes.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const stagedPaths = ctx.status.staged.map((s) => s.path);
  const trackedOrStagedSet = new Set([...trackedFiles, ...stagedPaths]);

  const exposedSensitive = [];
  for (const relPath of trackedOrStagedSet) {
    const classified = classifySensitivePath(relPath);
    if (classified) {
      exposedSensitive.push({ ...classified, state: 'tracked-or-staged' });
      errors.push(`Sensitive file is tracked or staged: ${classified.path} (${classified.category}).`);
    }
  }

  for (const relPath of ctx.status.untracked) {
    const classified = classifySensitivePath(relPath);
    if (classified) {
      exposedSensitive.push({ ...classified, state: 'untracked-unignored' });
      errors.push(
        `Sensitive file is untracked and not ignored by .gitignore: ${classified.path} (${classified.category}).`
      );
    }
  }

  const hasGitignore = existsSync(join(ctx.repoRoot, '.gitignore'));
  const envIgnoredRes = runGit(ctx.repoRoot, ['check-ignore', '-q', '.env']);
  const envIgnored = envIgnoredRes.status === 0;
  if (!hasGitignore || !envIgnored) {
    warnings.push('".env" is not ignored by .gitignore. Add ".env" and ".env.*" (with "!.env.example") to .gitignore.');
  }

  // 7. Remotes & worktrees
  if (ctx.remotes.length === 0) {
    warnings.push('No Git remote is configured (local-only repository).');
  }

  const strict = Boolean(options.strict);
  const ok = errors.length === 0 && (!strict || warnings.length === 0);
  const statusLabel = errors.length > 0 ? 'FAIL' : warnings.length > 0 ? (strict ? 'FAIL' : 'WARN') : 'PASS';

  return {
    ok,
    status: statusLabel,
    strict,
    repository: {
      root: ctx.repoRoot,
      branch: ctx.branch,
      detached: ctx.detached,
      headSha: ctx.headSha,
      isProtectedBranch: ctx.isProtectedBranch,
      upstream: ctx.upstream,
      remotes: ctx.remotes,
      inProgressOperation: ctx.inProgress ? ctx.inProgress.operation : null,
      worktreeCount: ctx.worktrees.length,
      worktrees: ctx.worktrees,
    },
    workingTree: {
      clean: dirtyCount === 0 && ctx.status.conflicted.length === 0,
      stagedCount: ctx.status.staged.length,
      unstagedCount: ctx.status.unstaged.length,
      untrackedCount: ctx.status.untracked.length,
      conflictedCount: ctx.status.conflicted.length,
      staged: ctx.status.staged,
      unstaged: ctx.status.unstaged,
      untracked: ctx.status.untracked,
      conflicted: ctx.status.conflicted,
    },
    hygiene: {
      hasGitignore,
      envIgnored,
      exposedSensitiveFiles: exposedSensitive,
    },
    errors,
    warnings,
    recommendations,
  };
}

export function formatDoctorReport(report) {
  const { repository: repo, workingTree: wt, hygiene } = report;
  const headDesc = repo.detached
    ? `DETACHED at ${repo.headSha || 'unborn'}`
    : `${repo.branch || '(unborn)'}${repo.headSha ? ` (${repo.headSha})` : ''}${repo.isProtectedBranch ? ' [protected/shared]' : ''}`;

  const lines = [
    `Git Agent Doctor: ${report.status}`,
    `  Branch / HEAD : ${headDesc}`,
    `  Working tree  : ${wt.clean ? 'clean' : `dirty (staged: ${wt.stagedCount}, unstaged: ${wt.unstagedCount}, untracked: ${wt.untrackedCount}, conflicted: ${wt.conflictedCount})`}`,
    `  In-progress   : ${repo.inProgressOperation || 'none'}`,
    `  Worktrees     : ${repo.worktreeCount}`,
    `  Remotes       : ${repo.remotes.length > 0 ? repo.remotes.join(', ') : 'none'}${repo.upstream ? ` (tracking ${repo.upstream})` : ''}`,
    `  Secret hygiene: ${hygiene.exposedSensitiveFiles.length === 0 && hygiene.envIgnored ? 'ok (.env ignored)' : `${hygiene.exposedSensitiveFiles.length} exposed file(s), .env ignored=${hygiene.envIgnored}`}`,
  ];

  if (report.errors.length > 0) {
    lines.push('', 'Errors:');
    for (const err of report.errors) lines.push(`  - ${err}`);
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warn of report.warnings) lines.push(`  - ${warn}`);
  }
  if (report.recommendations.length > 0) {
    lines.push('', 'Recommended next steps:');
    for (const rec of report.recommendations) lines.push(`  -> ${rec}`);
  }
  return lines.join('\n');
}
