import { classifySensitivePath, inspectRepoContext, runGit } from './git.mjs';

export const RECOVERY_SCENARIOS = [
  'uncommitted-mess',
  'wrong-branch',
  'conflict-in-progress',
  'accidental-reset',
  'bad-merge-on-main',
  'detached-head',
  'leaked-secret',
];

function getRecentReflog(repoRoot, count = 6) {
  const res = runGit(repoRoot, ['reflog', `-n`, String(count), '--format=%h|%gd|%gs']);
  if (res.status !== 0) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, selector, subject] = line.split('|');
      return { sha, selector, subject };
    });
}

function isHeadMergeCommit(repoRoot) {
  const res = runGit(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD^2']);
  return res.status === 0 ? res.stdout.trim() : null;
}

export function detectScenario(ctx) {
  if (ctx.inProgress || ctx.status.conflicted.length > 0) {
    return 'conflict-in-progress';
  }

  const trackedRes = runGit(ctx.repoRoot, ['ls-files']);
  const tracked = trackedRes.status === 0 ? trackedRes.stdout.split('\n').filter(Boolean) : [];
  const allCandidatePaths = [
    ...tracked,
    ...ctx.status.staged.map((s) => s.path),
    ...ctx.status.untracked,
  ];
  if (allCandidatePaths.some((p) => classifySensitivePath(p) !== null)) {
    return 'leaked-secret';
  }

  if (ctx.detached) {
    return 'detached-head';
  }

  const reflog = getRecentReflog(ctx.repoRoot, 5);
  if (reflog.length > 0 && /^reset: moving to/i.test(reflog[0].subject || '')) {
    return 'accidental-reset';
  }

  const dirty = ctx.status.staged.length + ctx.status.unstaged.length + ctx.status.untracked.length > 0;
  if (ctx.isProtectedBranch && dirty) {
    return 'wrong-branch';
  }

  if (ctx.isProtectedBranch && isHeadMergeCommit(ctx.repoRoot)) {
    return 'bad-merge-on-main';
  }

  if (dirty) {
    return 'uncommitted-mess';
  }

  return 'clean-state';
}

export function buildRecoveryPlan(dir, options = {}) {
  const ctx = inspectRepoContext(dir);
  const explicitScenario = options.scenario;
  if (explicitScenario && !RECOVERY_SCENARIOS.includes(explicitScenario)) {
    throw new Error(
      `Unknown recovery scenario "${explicitScenario}". Supported scenarios: ${RECOVERY_SCENARIOS.join(', ')}`
    );
  }

  const scenario = explicitScenario || detectScenario(ctx);
  const detectedAutomatically = !explicitScenario;
  const reflog = getRecentReflog(ctx.repoRoot, 6);
  const mergeSecondParent = isHeadMergeCommit(ctx.repoRoot);

  if (scenario === 'conflict-in-progress') {
    const op = ctx.inProgress ? ctx.inProgress.operation : 'merge';
    const abortCmd = ctx.inProgress ? ctx.inProgress.abortCommand : 'git merge --abort';
    const files = ctx.status.conflicted.map((c) => c.path);
    const sampleFile = files[0] || '<conflicted-file>';
    return {
      scenario,
      title: `Resolve or Safely Abort In-Progress ${op.toUpperCase()} Conflict`,
      detectedAutomatically,
      riskLevel: 'high',
      diagnosis:
        files.length > 0
          ? `Active ${op} has ${files.length} conflicted file(s): ${files.join(', ')}. Git halted before creating a commit so you can combine both branches' intent.`
          : `Inspecting recovery plan for an in-progress ${op} conflict.`,
      steps: [
        {
          command: 'git status',
          effect: 'Read-only',
          why: 'List every unmerged path (marked UU / both modified, AA / both added, etc.).',
        },
        {
          command: `git diff ${sampleFile}`,
          effect: 'Read-only',
          why: 'Inspect the conflict markers (<<<<<<< HEAD, =======, >>>>>>> branch) and understand both sides before editing.',
        },
        {
          command: `git add ${sampleFile} && git commit`,
          effect: 'Updates Index + records Merge Commit',
          why: 'After editing the file to keep the right logic from both branches and removing conflict markers, stage it and complete the merge.',
        },
        {
          command: abortCmd,
          effect: 'Restores Working Tree + Index to pre-merge state',
          why: `Escape hatch: if you are not ready to resolve the conflict, abort cleanly and return to the exact state before the ${op} started.`,
        },
      ],
      avoid: [
        {
          command: 'git reset --hard HEAD',
          reason: `Use "${abortCmd}" instead so Git cleans up ${op} metadata properly and restores pre-${op} state safely.`,
        },
        {
          command: 'Blindly accepting --ours or --theirs on the whole file',
          reason: 'Choosing one side wholesale silently deletes the other agent’s feature or bug fix when both touched the same module.',
        },
      ],
    };
  }

  if (scenario === 'wrong-branch') {
    const currentBranch = ctx.branch || 'main';
    return {
      scenario,
      title: `Move Work Off Protected Branch (${currentBranch}) to a Feature Branch`,
      detectedAutomatically,
      riskLevel: 'medium',
      diagnosis: `Working on "${currentBranch}" risks committing directly to the shared default branch or blocking future pulls.`,
      steps: [
        {
          command: 'git switch -c feat/<task-name>',
          effect: 'Creates new branch pointer + moves HEAD (preserves Working Tree & Index)',
          why: 'If your changes are not committed yet, switching to a new branch carries your staged and unstaged edits with you without touching main.',
        },
        {
          command: 'git status && git diff',
          effect: 'Read-only',
          why: 'Confirm your new branch is active and all your edits are intact.',
        },
        {
          command: `git branch -f ${currentBranch} origin/${currentBranch}`,
          effect: `Moves local ${currentBranch} pointer back to origin/${currentBranch} (only after switching to feat/<task-name>)`,
          why: `If you already created local commits on ${currentBranch} (and have NOT pushed them), first create "feat/<task-name>" at HEAD, then reset the local ${currentBranch} pointer back to origin/${currentBranch}.`,
        },
      ],
      avoid: [
        {
          command: `git push origin ${currentBranch}`,
          reason: 'Pushing unreviewed agent work directly to the default branch bypasses PR review and CI status checks.',
        },
        {
          command: 'git reset --hard origin/main (before creating the feature branch)',
          reason: 'Running reset --hard before creating a branch pointer permanently destroys uncommitted work and unreferenced local edits.',
        },
      ],
    };
  }

  if (scenario === 'accidental-reset') {
    const candidate = reflog[1] || reflog[0] || { sha: '<lost-commit-sha>', selector: 'HEAD@{1}', subject: 'previous commit' };
    return {
      scenario,
      title: 'Recover Lost Commits After Accidental Reset or Branch Deletion via Reflog',
      detectedAutomatically,
      riskLevel: 'medium',
      diagnosis: `Git keeps unreachable local commits in the reflog (by default 30 days for unreachable commits via gc.reflogExpireUnreachable). Latest candidate: ${candidate.sha} (${candidate.selector}: ${candidate.subject}).`,
      steps: [
        {
          command: 'git reflog -n 15',
          effect: 'Read-only',
          why: 'Locate the SHA of the commit that was active right before the accidental reset, rebase, or branch deletion.',
        },
        {
          command: `git show --stat ${candidate.sha}`,
          effect: 'Read-only',
          why: 'Verify that this commit SHA contains the exact files and changes you want to recover.',
        },
        {
          command: `git switch -c rescue/recovered-work ${candidate.sha}`,
          effect: 'Creates a new branch pointing to the recovered commit',
          why: 'Creating a rescue branch immediately re-anchors the commit so Git garbage collection will never prune it and your current branch stays untouched.',
        },
      ],
      avoid: [
        {
          command: 'git gc --prune=now',
          reason: 'Forcing immediate garbage collection permanently deletes unreachable commits that reflog would otherwise save.',
        },
        {
          command: 'Another git reset --hard while guessing SHAs',
          reason: 'Use "git switch -c rescue/..." instead of repeated hard resets so you never overwrite uncommitted files.',
        },
      ],
    };
  }

  if (scenario === 'bad-merge-on-main') {
    const mergeSha = ctx.headSha || '<merge-commit-sha>';
    return {
      scenario,
      title: 'Safely Undo a Faulty Merge on a Shared Branch (Without Rewriting History)',
      detectedAutomatically,
      riskLevel: 'high',
      diagnosis: mergeSecondParent
        ? `HEAD (${mergeSha}) is a merge commit (second parent: ${mergeSecondParent.slice(0, 7)}). Because "${ctx.branch || 'main'}" is shared, rewriting history with reset/force-push would break every teammate and agent worktree.`
        : 'Undoing a merged PR or merge commit on a shared branch requires a forward inverse commit rather than history rewriting.',
      steps: [
        {
          command: `git show --stat ${mergeSha}`,
          effect: 'Read-only',
          why: 'Confirm the merge commit SHA and verify that parent #1 is the target mainline branch (e.g., main) and parent #2 is the merged feature branch.',
        },
        {
          command: `git revert -m 1 ${mergeSha}`,
          effect: 'Creates a new commit that inverses the merge diff',
          why: 'Flag "-m 1" tells Git to keep parent 1 (mainline) as the baseline and reverse the changes introduced by parent 2, preserving an honest, append-only history.',
        },
        {
          command: 'npm test',
          effect: 'Read-only verification',
          why: 'Verify the test suite passes after reverting the faulty merge before pushing.',
        },
      ],
      avoid: [
        {
          command: 'git reset --hard HEAD~1 && git push --force origin main',
          reason: 'Never force-push to rewrite shared branch history: it orphans teammates’ branches and erases the audit trail.',
        },
      ],
    };
  }

  if (scenario === 'detached-head') {
    const sha = ctx.headSha || 'HEAD';
    return {
      scenario,
      title: 'Save Work Created in Detached HEAD State',
      detectedAutomatically,
      riskLevel: 'medium',
      diagnosis: `HEAD points directly to commit ${sha} instead of a branch name. If you switch to another branch now, any commits created here will become unreachable.`,
      steps: [
        {
          command: 'git status && git log --oneline -n 3',
          effect: 'Read-only',
          why: 'Check whether you have commits or uncommitted edits at the current detached HEAD position.',
        },
        {
          command: 'git switch -c feat/saved-from-detached',
          effect: 'Creates a named branch at current HEAD and switches to it',
          why: 'Attaches a permanent branch reference to your current commit and preserves any uncommitted edits in the working tree.',
        },
      ],
      avoid: [
        {
          command: 'git checkout main (before creating a branch)',
          reason: 'Switching away from a detached HEAD leaves commits made there without a branch pointer.',
        },
      ],
    };
  }

  if (scenario === 'leaked-secret') {
    return {
      scenario,
      title: 'Remove a Tracked or Staged Secret File Safely',
      detectedAutomatically,
      riskLevel: 'high',
      diagnosis: 'A sensitive file (such as .env or a private key) is staged, tracked, or unignored. Simply adding it to .gitignore after staging/committing will NOT untrack it.',
      steps: [
        {
          command: 'git rm --cached <secret-file>',
          effect: 'Removes file from Git Index while keeping the file on your local disk',
          why: 'Using "--cached" stops Git from tracking the file without deleting your local environment configuration.',
        },
        {
          command: 'echo ".env*" >> .gitignore',
          effect: 'Updates .gitignore in Working Tree',
          why: 'Prevents future "git add ." commands from re-staging the secret file (keep "!.env.example" for safe templates).',
        },
        {
          command: 'git add .gitignore && git commit -m "chore: untrack local env and update gitignore"',
          effect: 'Records removal in commit history',
          why: 'Commits the .gitignore rule and index removal. IMPORTANT: If the secret was already pushed to a remote repository, immediately rotate/revoke the credential.',
        },
      ],
      avoid: [
        {
          command: 'Only adding .env to .gitignore without git rm --cached',
          reason: 'Git ignores .gitignore rules for files that are already tracked in the index.',
        },
        {
          command: 'Assuming a revert commit hides a pushed API key',
          reason: 'Any secret ever pushed to GitHub remains readable in earlier commits and PR events; you must revoke and rotate the key.',
        },
      ],
    };
  }

  // Default: uncommitted-mess or clean-state
  return {
    scenario: scenario === 'clean-state' ? 'uncommitted-mess' : scenario,
    title: 'Shelve or Discard Unwanted Working-Tree Changes Safely',
    detectedAutomatically,
    riskLevel: 'low',
    diagnosis:
      scenario === 'clean-state'
        ? 'Working tree is currently clean. Showing baseline recovery plan for managing unwanted uncommitted edits.'
        : `Working tree has uncommitted changes (staged: ${ctx.status.staged.length}, unstaged: ${ctx.status.unstaged.length}, untracked: ${ctx.status.untracked.length}).`,
    steps: [
      {
        command: 'git status && git diff',
        effect: 'Read-only',
        why: 'Inspect unstaged changes before deciding what to keep or discard.',
      },
      {
        command: 'git stash push -u -m "wip: save before cleanup"',
        effect: 'Saves Working Tree + Index + untracked files (-u) onto the local stash stack and cleans Working Tree',
        why: 'Safest way to clear your working directory: unlike "git restore" or "git reset --hard", stashed changes can be recovered later with "git stash list" and "git stash apply".',
      },
      {
        command: 'git restore --staged <file>',
        effect: 'Moves file from Staging Area back to unstaged Working Tree',
        why: 'Unstages a file that was added with "git add" without discarding your edits to the file.',
      },
      {
        command: 'git restore <file>',
        effect: 'Overwrites unstaged Working Tree file with the version in Index/HEAD',
        why: 'Discards unstaged edits in a specific out-of-scope file touched by an agent while leaving the rest of your work intact.',
      },
    ],
    avoid: [
      {
        command: 'git reset --hard && git clean -fd',
        reason: 'Permanently destroys all uncommitted tracked and untracked files without saving a copy in the reflog or stash.',
      },
    ],
  };
}

export function formatRecoveryPlan(plan) {
  const lines = [
    `Git Agent Recovery Plan [${plan.scenario}] (risk: ${plan.riskLevel.toUpperCase()})`,
    `Title    : ${plan.title}`,
    `Diagnosis: ${plan.diagnosis}`,
    '',
    'Safe step-by-step commands (not executed automatically):',
  ];
  plan.steps.forEach((step, idx) => {
    lines.push(`  ${idx + 1}. $ ${step.command}`);
    lines.push(`     Effect : ${step.effect}`);
    lines.push(`     Why    : ${step.why}`);
  });
  if (plan.avoid.length > 0) {
    lines.push('', 'What NOT to run (Red Flags):');
    for (const item of plan.avoid) {
      lines.push(`  [!] ${item.command}`);
      lines.push(`      Reason: ${item.reason}`);
    }
  }
  return lines.join('\n');
}
