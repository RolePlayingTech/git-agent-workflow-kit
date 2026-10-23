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
3. **Implement, stage intentionally, and create an atomic commit**:
   - Inspect `git status` and `git diff` before staging.
   - Stage specific in-scope files (`git add <file>` or `git add -p`) rather than blindly running `git add .` when untracked scratch files exist.
   - Review the staged diff (`git diff --cached`), run the project's fast and test checks (`npm run check`, `npm test`), and create an atomic commit:
     ```bash
     git diff --cached
     npm test
     git commit -m "feat(<scope>): concise summary of why"
     ```
4. **Run the post-commit PR readiness & scope audit**:
   - `pr-ready` requires a clean working tree (it rejects uncommitted staged or unstaged edits) and audits the committed branch diff (`<base>...HEAD`):
     ```bash
     npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base origin/main --allow "<in-scope-glob>" --strict
     ```
   - If `pr-ready` flags an out-of-scope file in your commit, restore that file from the base branch and amend the local commit before re-running `pr-ready`:
     ```bash
     git restore --source=origin/main --staged --worktree <out-of-scope-file>
     git commit --amend --no-edit
     ```
   - Fix any sensitive-file, conflict-marker, or test-weakening findings before pushing.
5. **Push and open the Pull Request with honest evidence**:
   - Push the branch (`git push -u origin feat/<issue-number>-<short-slug>`), link the issue (`Closes #<number>`), summarize *why* the approach was chosen, list the exact verification commands run and their results, and call out any high-attention files (migrations, CI, lockfiles).
   - Never merge the PR yourself unless the user explicitly authorizes merging.

<!-- git-agent-workflow-kit:managed sha256=89f83171bba86731d78b25851466e5dbfdef295b0df5a6f9c31165a23dbf1ff9 -->
