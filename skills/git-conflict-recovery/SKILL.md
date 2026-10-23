---
name: git-conflict-recovery
description: Diagnose and recover from Git merge/rebase conflicts, wrong-branch edits, detached HEAD, or faulty merges without destructive commands. Use when a merge fails, commits seem lost, or a shared branch needs a safe revert.
---

# Safe Git Conflict Resolution & Recovery

Never guess destructive Git commands (`git reset --hard`, `git push --force`, `git clean -fd`) when a repository is in an unexpected state.

## Procedure

1. **Generate a read-only recovery plan first**:
   ```bash
   npx github:RolePlayingTech/git-agent-workflow-kit doctor .
   npx github:RolePlayingTech/git-agent-workflow-kit recovery-plan .
   ```
2. **Follow non-destructive recovery rules by scenario**:
   - **Uncommitted edits needed elsewhere**: Use `git stash push -u -m "wip"` or `git switch -c feat/<name>` instead of `git reset --hard`.
   - **Merge / Rebase conflict in progress**: Inspect both sides with `git status` and `git diff <file>`. Combine the intended logic of both branches, remove `<<<<<<<`, `=======`, `>>>>>>>` markers, run tests, and `git add <file>`. If unsure, abort cleanly with `git merge --abort` or `git rebase --abort`.
   - **Lost commit after accidental reset**: Run `git reflog -n 15`, inspect the commit with `git show --stat <sha>`, and anchor it on a rescue branch with `git switch -c rescue/<name> <sha>`.
   - **Faulty merge already on a shared branch (`main`)**: Never rewrite shared history with `reset` + `push --force`. Create a forward inverse commit with `git revert -m 1 <merge-commit-sha>` and run the test suite.

## Hard Boundary

- Always ask the user for explicit confirmation before running any command that discards uncommitted changes or rewrites branch history.

<!-- git-agent-workflow-kit:managed sha256=5c3af9f062300eabf782e4e5b43cb6e68784239c7c46d321a2b580a358dcc4cd -->
