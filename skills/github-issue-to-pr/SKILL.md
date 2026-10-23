---
name: github-issue-to-pr
description: Execute a disciplined Issue -> Branch -> Atomic Commit -> Scope Audit -> Pull Request workflow. Use when implementing a GitHub issue, bug fix, or feature intended for code review.
---

# GitHub Issue to Pull Request Workflow

Keep every pull request reviewable, scoped to one task, and backed by real verification output.

## Procedure

1. **Extract the Task Contract from the Issue**:
   - Write down the goal in one sentence, the allowed file scope (which directories/files should change), and the verification commands required before done.
2. **Isolate the branch (or worktree)**:
   - Branch from the latest `origin/main` using a descriptive prefix (`feat/`, `fix/`, `docs/`, `test/`, `refactor/`):
     ```bash
     git switch -c feat/<issue-number>-<short-slug> origin/main
     ```
3. **Implement and stage intentionally**:
   - Inspect `git status` and `git diff` before staging.
   - Stage specific files (`git add <file>` or `git add -p`) rather than blindly running `git add .` when untracked scratch files exist.
4. **Run the pre-PR readiness & scope audit**:
   ```bash
   npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base origin/main --allow "<in-scope-glob>"
   ```
   - Restore any out-of-scope files with `git restore <file>`.
   - Fix any sensitive-file, conflict-marker, or test-weakening findings before committing.
5. **Open the Pull Request with honest evidence**:
   - Link the issue (`Closes #<number>`), summarize *why* the approach was chosen, list the exact verification commands run and their results, and call out any high-attention files (migrations, CI, lockfiles).
   - Never merge the PR yourself unless the user explicitly authorizes merging.

<!-- git-agent-workflow-kit:managed sha256=519cb6d3ad71ff48adf703578d9312311ee3d8d0354d9cd1282049aa3c246472 -->
