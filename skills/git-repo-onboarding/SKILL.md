---
name: git-repo-onboarding
description: Audit a Git repository before starting coding-agent work: verify active branch, worktrees, uncommitted state, and .gitignore secret hygiene. Use when starting a session in a repository or before creating a task branch.
---

# Git Repository Onboarding

Before modifying any file in the repository, verify the working state so you do not overwrite another agent's work, commit on a protected branch, or stage unignored secrets.

## Procedure

1. **Run a read-only diagnostic check**:
   ```bash
   npx github:RolePlayingTech/git-agent-workflow-kit doctor .
   ```
   *(If `git-agent` is installed locally, run `git-agent doctor .`; otherwise run `git status --short --branch` and `git worktree list`).*
2. **Check for active worktrees or uncommitted changes**:
   - If the working tree already contains uncommitted changes from another task or parallel agent, **STOP**. Do not run `git checkout`, `git stash`, or `git reset` in that directory. Ask the user or create an isolated `git worktree`.
3. **Verify branch isolation**:
   - Never start feature or bug-fix edits directly on `main`, `master`, or `production`, or in `detached HEAD`.
   - Create a short-lived task branch from the up-to-date base branch:
     ```bash
     git fetch origin
     git switch -c feat/<issue-or-task-slug> origin/main
     ```
4. **Verify secret & artifact hygiene**:
   - Confirm `.env`, `.env.*`, private keys, and build/test artifacts (`dist/`, `node_modules/`, `playwright-report/`) are listed in `.gitignore` before running any command that generates files.

## Responsibility Boundary

- This skill governs **live Git repository state and branch setup**.
- Project-wide build/test commands and approval rules belong in `AGENTS.md` (managed by `agent-harness-kit`).

<!-- git-agent-workflow-kit:managed sha256=54ec335bb93211bacd11909b57df16ae4d681f19880bf1a0636da3e3be2c1483 -->
