---
name: pr-readiness-review
description: Perform an independent code review of a branch or Pull Request diff: detect scope creep, weakened test assertions, leaked secrets, and risky migrations. Use when reviewing an AI agent or teammate PR before approval.
---

# Pull Request Readiness & Independent Diff Review

Green CI alone does not prove a PR is safe to merge. Review the actual diff independently of the author agent's self-report.

## Procedure

1. **Run the automated PR readiness check**:
   ```bash
   npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base origin/main --strict
   ```
2. **Inspect the full diff and file list**:
   ```bash
   git diff --stat origin/main...HEAD
   git diff origin/main...HEAD
   ```
3. **Check the Four AI-Agent Failure Modes**:
   - **Scope creep**: Did the branch modify unrelated components, formatting, lockfiles, or config files outside the issue scope?
   - **Weakened tests (Greenwashing)**: Did the diff delete assertions (`expect`, `assert`), add `.skip`/`.todo`, or replace strict status/value checks (`toBe(403)`) with tautologies (`toBeDefined()`) to make failing tests pass?
   - **Silent contract / schema drift**: Did the diff alter database migrations, API response shapes, or `AGENTS.md` / `.github/workflows` without explicit discussion?
   - **Secret or artifact leakage**: Are any `.env` files, tokens, or build outputs included in the commits?
4. **Deliver a structured verdict**:
   - Report blocking findings (`Request changes`) vs non-blocking suggestions, citing exact `file:line` locations.

<!-- git-agent-workflow-kit:managed sha256=934c99729d596f9d37c62df34ddaf545d9a45aea381460d353c5de0240066b7b -->
