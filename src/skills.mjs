import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertSafeChildPath,
  formatUnifiedDiff,
  stampManagedContent,
  verifyManagedContent,
} from './fs-safe.mjs';

const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const BUILTIN_SKILLS = [
  {
    name: 'git-repo-onboarding',
    description:
      'Audit a Git repository before starting coding-agent work: verify active branch, worktrees, uncommitted state, and .gitignore secret hygiene. Use when starting a session in a repository or before creating a task branch.',
    body: `---
name: git-repo-onboarding
description: Audit a Git repository before starting coding-agent work: verify active branch, worktrees, uncommitted state, and .gitignore secret hygiene. Use when starting a session in a repository or before creating a task branch.
---

# Git Repository Onboarding

Before modifying any file in the repository, verify the working state so you do not overwrite another agent's work, commit on a protected branch, or stage unignored secrets.

## Procedure

1. **Run a read-only diagnostic check**:
   \`\`\`bash
   npx github:RolePlayingTech/git-agent-workflow-kit doctor .
   \`\`\`
   *(If \`git-agent\` is installed locally, run \`git-agent doctor .\`; otherwise run \`git status --short --branch\` and \`git worktree list\`).*
2. **Check for active worktrees or uncommitted changes**:
   - If the working tree already contains uncommitted changes from another task or parallel agent, **STOP**. Do not run \`git checkout\`, \`git stash\`, or \`git reset\` in that directory. Ask the user or create an isolated \`git worktree\`.
3. **Verify branch isolation**:
   - Never start feature or bug-fix edits directly on \`main\`, \`master\`, or \`production\`, or in \`detached HEAD\`.
   - Create a short-lived task branch from the up-to-date base branch:
     \`\`\`bash
     git fetch origin
     git switch -c feat/<issue-or-task-slug> origin/main
     \`\`\`
4. **Verify secret & artifact hygiene**:
   - Confirm \`.env\`, \`.env.*\`, private keys, and build/test artifacts (\`dist/\`, \`node_modules/\`, \`playwright-report/\`) are listed in \`.gitignore\` before running any command that generates files.

## Responsibility Boundary

- This skill governs **live Git repository state and branch setup**.
- Project-wide build/test commands and approval rules belong in \`AGENTS.md\` (managed by \`agent-harness-kit\`).`,
  },
  {
    name: 'github-issue-to-pr',
    description:
      'Execute a disciplined Issue -> Branch -> Atomic Commit -> Scope Audit -> Pull Request workflow. Use when implementing a GitHub issue, bug fix, or feature intended for code review.',
    body: `---
name: github-issue-to-pr
description: Execute a disciplined Issue -> Branch -> Atomic Commit -> Scope Audit -> Pull Request workflow. Use when implementing a GitHub issue, bug fix, or feature intended for code review.
---

# GitHub Issue to Pull Request Workflow

Keep every pull request reviewable, scoped to one task, and backed by real verification output.

## Procedure

1. **Extract the Task Contract from the Issue**:
   - Write down the goal in one sentence, the allowed file scope (which directories/files should change), and the verification commands required before done.
2. **Isolate the branch (or worktree)**:
   - Branch from the latest \`origin/main\` using a descriptive prefix (\`feat/\`, \`fix/\`, \`docs/\`, \`test/\`, \`refactor/\`):
     \`\`\`bash
     git switch -c feat/<issue-number>-<short-slug> origin/main
     \`\`\`
3. **Implement and stage intentionally**:
   - Inspect \`git status\` and \`git diff\` before staging.
   - Stage specific files (\`git add <file>\` or \`git add -p\`) rather than blindly running \`git add .\` when untracked scratch files exist.
4. **Run the pre-PR readiness & scope audit**:
   \`\`\`bash
   npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base origin/main --allow "<in-scope-glob>"
   \`\`\`
   - Restore any out-of-scope files with \`git restore <file>\`.
   - Fix any sensitive-file, conflict-marker, or test-weakening findings before committing.
5. **Open the Pull Request with honest evidence**:
   - Link the issue (\`Closes #<number>\`), summarize *why* the approach was chosen, list the exact verification commands run and their results, and call out any high-attention files (migrations, CI, lockfiles).
   - Never merge the PR yourself unless the user explicitly authorizes merging.`,
  },
  {
    name: 'pr-readiness-review',
    description:
      'Perform an independent code review of a branch or Pull Request diff: detect scope creep, weakened test assertions, leaked secrets, and risky migrations. Use when reviewing an AI agent or teammate PR before approval.',
    body: `---
name: pr-readiness-review
description: Perform an independent code review of a branch or Pull Request diff: detect scope creep, weakened test assertions, leaked secrets, and risky migrations. Use when reviewing an AI agent or teammate PR before approval.
---

# Pull Request Readiness & Independent Diff Review

Green CI alone does not prove a PR is safe to merge. Review the actual diff independently of the author agent's self-report.

## Procedure

1. **Run the automated PR readiness check**:
   \`\`\`bash
   npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base origin/main --strict
   \`\`\`
2. **Inspect the full diff and file list**:
   \`\`\`bash
   git diff --stat origin/main...HEAD
   git diff origin/main...HEAD
   \`\`\`
3. **Check the Four AI-Agent Failure Modes**:
   - **Scope creep**: Did the branch modify unrelated components, formatting, lockfiles, or config files outside the issue scope?
   - **Weakened tests (Greenwashing)**: Did the diff delete assertions (\`expect\`, \`assert\`), add \`.skip\`/\`.todo\`, or replace strict status/value checks (\`toBe(403)\`) with tautologies (\`toBeDefined()\`) to make failing tests pass?
   - **Silent contract / schema drift**: Did the diff alter database migrations, API response shapes, or \`AGENTS.md\` / \`.github/workflows\` without explicit discussion?
   - **Secret or artifact leakage**: Are any \`.env\` files, tokens, or build outputs included in the commits?
4. **Deliver a structured verdict**:
   - Report blocking findings (\`Request changes\`) vs non-blocking suggestions, citing exact \`file:line\` locations.`,
  },
  {
    name: 'git-conflict-recovery',
    description:
      'Diagnose and recover from Git merge/rebase conflicts, wrong-branch edits, detached HEAD, or faulty merges without destructive commands. Use when a merge fails, commits seem lost, or a shared branch needs a safe revert.',
    body: `---
name: git-conflict-recovery
description: Diagnose and recover from Git merge/rebase conflicts, wrong-branch edits, detached HEAD, or faulty merges without destructive commands. Use when a merge fails, commits seem lost, or a shared branch needs a safe revert.
---

# Safe Git Conflict Resolution & Recovery

Never guess destructive Git commands (\`git reset --hard\`, \`git push --force\`, \`git clean -fd\`) when a repository is in an unexpected state.

## Procedure

1. **Generate a read-only recovery plan first**:
   \`\`\`bash
   npx github:RolePlayingTech/git-agent-workflow-kit doctor .
   npx github:RolePlayingTech/git-agent-workflow-kit recovery-plan .
   \`\`\`
2. **Follow non-destructive recovery rules by scenario**:
   - **Uncommitted edits needed elsewhere**: Use \`git stash push -u -m "wip"\` or \`git switch -c feat/<name>\` instead of \`git reset --hard\`.
   - **Merge / Rebase conflict in progress**: Inspect both sides with \`git status\` and \`git diff <file>\`. Combine the intended logic of both branches, remove \`<<<<<<<\`, \`=======\`, \`>>>>>>>\` markers, run tests, and \`git add <file>\`. If unsure, abort cleanly with \`git merge --abort\` or \`git rebase --abort\`.
   - **Lost commit after accidental reset**: Run \`git reflog -n 15\`, inspect the commit with \`git show --stat <sha>\`, and anchor it on a rescue branch with \`git switch -c rescue/<name> <sha>\`.
   - **Faulty merge already on a shared branch (\`main\`)**: Never rewrite shared history with \`reset\` + \`push --force\`. Create a forward inverse commit with \`git revert -m 1 <merge-commit-sha>\` and run the test suite.

## Hard Boundary

- Always ask the user for explicit confirmation before running any command that discards uncommitted changes or rewrites branch history.`,
  },
  {
    name: 'multi-agent-worktree',
    description:
      'Coordinate multiple AI coding agents working in parallel using isolated git worktree directories and non-overlapping file scopes. Use when running two or more agents concurrently on the same repository.',
    body: `---
name: multi-agent-worktree
description: Coordinate multiple AI coding agents working in parallel using isolated git worktree directories and non-overlapping file scopes. Use when running two or more agents concurrently on the same repository.
---

# Parallel Multi-Agent Workflows with \`git worktree\`

Two coding agents sharing one working directory will overwrite each other's uncommitted edits, corrupt the Git index, or switch branches underneath one another. Use \`git worktree\` so each agent gets an isolated directory backed by the same \`.git\` object store.

## Procedure

1. **Check whether tasks should run in parallel**:
   - **Good fit for parallel worktrees**: Independent features, separate lessons/pages, isolated bug fixes, or an independent reviewer agent inspecting a PR while another agent codes.
   - **Bad fit (run sequentially instead)**: Two tasks editing the same database migration sequence, the same core auth middleware, or tightly coupled shared type definitions.
2. **Create an isolated worktree per agent from \`origin/main\`**:
   \`\`\`bash
   git fetch origin
   git worktree add ../<repo>-<task-slug> -b feat/<task-slug> origin/main
   \`\`\`
   - Verify active worktrees with \`git worktree list\`.
   - Note: Git prevents checking out the same branch in two worktrees simultaneously, protecting against accidental dual-branch mutation.
3. **Assign explicit file scopes to each agent**:
   - Give each agent an \`--allow "<glob>"\` scope and verify its branch with \`git-agent pr-ready --base origin/main --allow "<glob>"\` before opening a PR.
4. **Integrate sequentially and clean up**:
   - Merge the first verified PR into \`main\`, rebase or merge \`origin/main\` into the second agent's worktree, re-run full verification, and then remove finished worktrees:
     \`\`\`bash
     git worktree remove ../<repo>-<task-slug>
     git worktree prune
     \`\`\``,
  },
];

export function validateSkillDefinition(skill) {
  if (!skill || typeof skill !== 'object') {
    throw new Error('Skill definition must be an object.');
  }
  if (typeof skill.name !== 'string' || skill.name.length < 1 || skill.name.length > 64 || !SKILL_NAME_REGEX.test(skill.name)) {
    throw new Error(`Invalid skill name "${skill.name}": must be 1-64 lowercase alphanumeric chars with single hyphens.`);
  }
  if (typeof skill.description !== 'string' || skill.description.length < 10 || skill.description.length > 1024) {
    throw new Error(`Invalid description for skill "${skill.name}": must be 10-1024 characters.`);
  }
  if (!/\bUse when\b/i.test(skill.description)) {
    throw new Error(`Skill "${skill.name}" description must include a "Use when ..." trigger clause.`);
  }
  return true;
}

export function getStampedSkillContent(skillName) {
  const found = BUILTIN_SKILLS.find((s) => s.name === skillName);
  if (!found) {
    throw new Error(`Unknown skill "${skillName}". Available skills: ${BUILTIN_SKILLS.map((s) => s.name).join(', ')}`);
  }
  validateSkillDefinition(found);
  return stampManagedContent(found.body);
}

export function listSkills() {
  return BUILTIN_SKILLS.map((s) => {
    validateSkillDefinition(s);
    const stamped = stampManagedContent(s.body);
    const verification = verifyManagedContent(stamped);
    return {
      name: s.name,
      description: s.description,
      sha256: verification.digest,
    };
  });
}

export function resolveInstallTargets(targetOption = 'claude') {
  if (targetOption === 'claude') return ['.claude/skills'];
  if (targetOption === 'agents') return ['.agents/skills'];
  if (targetOption === 'both') return ['.claude/skills', '.agents/skills'];
  throw new Error(`Unknown --target "${targetOption}". Expected "claude", "agents", or "both".`);
}

export function planSkillsInstall(dir, options = {}) {
  const targetPrefixes = resolveInstallTargets(options.target || 'claude');
  const force = Boolean(options.force);
  const selectedNames =
    Array.isArray(options.skills) && options.skills.length > 0
      ? options.skills
      : BUILTIN_SKILLS.map((s) => s.name);

  const planned = [];
  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0 };

  for (const name of selectedNames) {
    const content = getStampedSkillContent(name);
    for (const prefix of targetPrefixes) {
      const relPath = `${prefix}/${name}/SKILL.md`;
      const safe = assertSafeChildPath(dir, relPath);
      const exists = existsSync(safe.fullPath);

      if (!exists) {
        counts.create += 1;
        planned.push({
          skill: name,
          relPath: safe.relPath,
          fullPath: safe.fullPath,
          action: 'create',
          reason: 'new file',
          content,
          diff: formatUnifiedDiff(safe.relPath, null, content),
        });
        continue;
      }

      const existingText = readFileSync(safe.fullPath, 'utf8').replace(/\r\n/g, '\n');
      if (existingText === content) {
        counts.unchanged += 1;
        planned.push({
          skill: name,
          relPath: safe.relPath,
          fullPath: safe.fullPath,
          action: 'unchanged',
          reason: 'already up to date',
          content,
          diff: '',
        });
        continue;
      }

      const checkManaged = verifyManagedContent(existingText);
      if (checkManaged.managed && checkManaged.valid) {
        counts.update += 1;
        planned.push({
          skill: name,
          relPath: safe.relPath,
          fullPath: safe.fullPath,
          action: 'update',
          reason: 'managed skill updated',
          content,
          diff: formatUnifiedDiff(safe.relPath, existingText, content),
        });
      } else if (force) {
        counts.update += 1;
        planned.push({
          skill: name,
          relPath: safe.relPath,
          fullPath: safe.fullPath,
          action: 'update',
          reason: 'overwritten with --force',
          content,
          diff: formatUnifiedDiff(safe.relPath, existingText, content),
        });
      } else {
        counts.conflict += 1;
        planned.push({
          skill: name,
          relPath: safe.relPath,
          fullPath: safe.fullPath,
          action: 'conflict',
          reason: checkManaged.managed
            ? 'hand-edited after generation (sha256 mismatch)'
            : 'unmanaged existing file (missing ownership marker)',
          content,
          diff: formatUnifiedDiff(safe.relPath, existingText, content),
        });
      }
    }
  }

  return { counts, files: planned };
}

export function applySkillsInstall(plan, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  if (dryRun) return plan;

  if (plan.counts.conflict > 0 && !force) {
    throw new Error(
      `Refusing to overwrite ${plan.counts.conflict} conflicting skill file(s). Re-run with --force if you intend to replace them.`
    );
  }

  for (const item of plan.files) {
    if (item.action === 'create' || item.action === 'update') {
      mkdirSync(dirname(item.fullPath), { recursive: true });
      writeFileSync(item.fullPath, item.content, 'utf8');
    }
  }
  return plan;
}
