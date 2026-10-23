---
name: multi-agent-worktree
description: Coordinate multiple AI coding agents working in parallel using isolated git worktree directories and non-overlapping file scopes. Use when running two or more agents concurrently on the same repository.
---

# Parallel Multi-Agent Workflows with `git worktree`

Two coding agents sharing one working directory will overwrite each other's uncommitted edits, corrupt the Git index, or switch branches underneath one another. Use `git worktree` so each agent gets an isolated directory backed by the same `.git` object store.

## Procedure

1. **Check whether tasks should run in parallel**:
   - **Good fit for parallel worktrees**: Independent features, separate lessons/pages, isolated bug fixes, or an independent reviewer agent inspecting a PR while another agent codes.
   - **Bad fit (run sequentially instead)**: Two tasks editing the same database migration sequence, the same core auth middleware, or tightly coupled shared type definitions.
2. **Create an isolated worktree per agent from `origin/main`**:
   ```bash
   git fetch origin
   git worktree add ../<repo>-<task-slug> -b feat/<task-slug> origin/main
   ```
   - Verify active worktrees with `git worktree list`.
   - Note: Git prevents checking out the same branch in two worktrees simultaneously, protecting against accidental dual-branch mutation.
3. **Assign explicit file scopes to each agent**:
   - Give each agent an `--allow "<glob>"` scope and verify its branch with `git-agent pr-ready --base origin/main --allow "<glob>"` before opening a PR.
4. **Integrate sequentially and clean up**:
   - Merge the first verified PR into `main`, rebase or merge `origin/main` into the second agent's worktree, re-run full verification, and then remove finished worktrees:
     ```bash
     git worktree remove ../<repo>-<task-slug>
     git worktree prune
     ```

<!-- git-agent-workflow-kit:managed sha256=0bc4c0c3b73a7eaae570ea41b4758e643c15361cf8fd824c8e946fc2a20c763c -->
