# Git Agent Workflow Kit

**Read-only Git & PR diagnostics, non-destructive recovery plans, multi-agent worktree sandboxes, and portable Agent Skills for AI coding workflows.**

Coding agents can generate hundreds of lines of code in seconds, but they routinely create four operational problems in real repositories:

1. **Working directly on `main` or inside another agent's dirty working tree**, overwriting uncommitted files or staging unignored `.env` secrets.
2. **Scope creep in Pull Requests**, modifying unrelated modules, lockfiles, or CI workflows outside the issue they were asked to solve.
3. **Greenwashing failing tests**, deleting assertions or replacing strict status checks (`assert.strictEqual(res.status, 403)`) with tautologies (`assert.ok(res.status)`) so `npm test` turns green while the bug remains.
4. **Destructive panic recovery**, running `git reset --hard` or `git push --force` when a merge conflict or wrong-branch commit occurs.

`git-agent-workflow-kit` gives developers, vibecoders, and AI coding agents a **zero-dependency Node.js CLI (`git-agent`)** and **five portable Agent Skills (`SKILL.md`)** that inspect live Git state, enforce task file scopes, detect weakened tests, and generate step-by-step non-destructive recovery plans.

> Built as the open-source companion to **[MUMRO Academy Lesson 16: Git Isn't a Save Button — Version Control in the Age of AI Coding Agents](https://academy.mumro.io/lessons/git-and-github-for-ai-coding-agents/)** ([Polish edition](https://academy.mumro.io/pl/lessons/git-and-github-for-ai-coding-agents/)).

---

## Responsibility Boundary in the RolePlayingTech Ecosystem

| Kit | Scope | What it manages |
| :--- | :--- | :--- |
| **[`agent-harness-kit`](https://github.com/RolePlayingTech/agent-harness-kit)** | Repository Harness (Lesson 13) | Static project instructions (`AGENTS.md`, `CLAUDE.md`), project verification commands, and harness maintenance from `.harness/spec.json`. |
| **[`mcp-surface-kit`](https://github.com/RolePlayingTech/mcp-surface-kit)** | Product MCP Surface (Lesson 14) | Declarative MCP tool tiers (`read`, `draft`, `delete`, `mutate`), `prepare → confirm` pairs, and OAuth scopes from `.mcp-surface/spec.json`. |
| **`git-agent-workflow-kit`** | Live Git & PR Operations (Lesson 16) | Live repository diagnostics (`doctor`), pre-PR scope & test-integrity audits (`pr-ready`), non-destructive Git recovery plans (`recovery-plan`), multi-agent sandboxes (`sandbox`), and Git/GitHub workflow skills (`skills`). |

---

## Quick Start

Requires **Node.js 20+** and **Git**. Zero runtime dependencies. No GitHub token is required for local commands.

```bash
# 1. Inspect current repository health, active branch, worktrees, and .gitignore secret hygiene
npx github:RolePlayingTech/git-agent-workflow-kit doctor .

# 2. Audit a feature branch against main with an explicit file-scope allowlist
npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base origin/main --allow "src/auth/**" --allow "tests/auth/**" --strict

# 3. Generate a safe, non-destructive recovery plan for the current repo state (or a specific scenario)
npx github:RolePlayingTech/git-agent-workflow-kit recovery-plan .
npx github:RolePlayingTech/git-agent-workflow-kit recovery-plan . --scenario bad-merge-on-main

# 4. Preview or install the 5 portable Git/GitHub Agent Skills (.claude/skills or .agents/skills)
npx github:RolePlayingTech/git-agent-workflow-kit skills list
npx github:RolePlayingTech/git-agent-workflow-kit skills install . --target claude --dry-run

# 5. Create reproducible local Git sandboxes for Lesson 16 hands-on labs (no internet or AI keys needed)
npx github:RolePlayingTech/git-agent-workflow-kit sandbox lab-a ./my-lab-a
npx github:RolePlayingTech/git-agent-workflow-kit sandbox lab-b ./my-lab-b
```

---

## CLI Commands & What They Check

### 1. `git-agent doctor [dir] [--strict] [--json]`

Performs a read-only pre-flight inspection before an agent or developer starts editing files:

- **Branch & `HEAD` state**: Warns if you are on a protected/shared branch (`main`, `master`, `production`, `trunk`, `release`) or in `detached HEAD` state where commits can become orphaned.
- **In-progress operations & conflicts**: Fails if a `merge`, `rebase`, `cherry-pick`, `revert`, or `bisect` is halted mid-flight, or if any file has unresolved conflict status (`UU`, `AA`, `DD`) or leftover `<<<<<<<` / `>>>>>>>` conflict markers.
- **Secret & `.gitignore` hygiene**: Checks tracked, staged, and untracked files for sensitive paths (`.env`, `.env.local`, `*.pem`, `*.key`, `id_rsa`, `credentials.json` — while allowing `.env.example` / `.env.template`). Reports **only file paths and categories**; never reads or logs secret values.
- **Active `git worktree` checkouts**: Lists all worktrees attached to the repository so parallel agents can see if another worktree is active.

### 2. `git-agent pr-ready [dir] [options]`

Options: `--base <ref>`, `--allow <glob>` (repeatable or comma-separated), `--max-files <n>` (default `20`), `--max-lines <n>` (default `800`), `--gh`, `--strict`, `--json`.

Audits whether a branch is ready for a Pull Request:

- **Branch & working-tree gate**: Fails if run on `main`/`master`, in `detached HEAD`, with 0 commits ahead of base, or with uncommitted staged/unstaged changes.
- **Task scope enforcement (`--allow`)**: Compares every file changed in `base...HEAD` against your allowed globs and fails on any out-of-scope file modifications (*scope creep*).
- **Test-integrity detector**: Inspects modified test files (`tests/**`, `*.test.*`, `*.spec.*`) in `base...HEAD`. Warns (and fails under `--strict`) if a test file removes assertions (`expect(...)`, `assert.*`), adds `.skip` / `.todo`, or replaces strict checks (`toBe`, `strictEqual`) with weak tautologies (`toBeDefined()`, `assert.ok(res.status)`).
- **High-attention & secret file checks**: Fails if any secret file is in the diff; warns when CI workflows (`.github/workflows/**`), database migrations (`migrations/**`, `schema.prisma`), dependency lockfiles, or governance files (`AGENTS.md`, `CLAUDE.md`, `CODEOWNERS`) are modified.
- **Optional GitHub CLI (`--gh`)**: When `--gh` is explicitly passed, queries `gh pr view` (read-only) to attach live PR review decision and CI check status.

### 3. `git-agent recovery-plan [dir] [--scenario <id>] [--json]`

Auto-detects the current repository problem (or accepts `--scenario <id>`) and prints a safe, non-destructive recovery plan explaining what each command changes in the **Working Tree**, **Staging Area (Index)**, and **Commit History**, plus explicit **Red Flags** (what *not* to run):

| Scenario ID | Situation | Primary Safe Mechanism |
| :--- | :--- | :--- |
| `uncommitted-mess` | Unwanted or mixed uncommitted changes in the working tree | `git stash push -u` / `git restore --staged` / `git restore <file>` |
| `wrong-branch` | Edits or unpushed commits made directly on `main` | `git switch -c feat/<name>` (then reset local `main` to `origin/main`) |
| `conflict-in-progress` | Halted `merge` or `rebase` with `UU` unmerged paths | Inspect `git diff`, resolve both intents, or abort with `git merge --abort` |
| `accidental-reset` | Lost commits after accidental `git reset --hard` or branch deletion | Find SHA in `git reflog` and anchor with `git switch -c rescue/<name> <sha>` |
| `bad-merge-on-main` | Faulty PR or branch already merged onto shared `main` | Forward inverse commit: `git revert -m 1 <merge-commit-sha>` |
| `detached-head` | Commits or edits made while `HEAD` is detached | Re-attach a named branch at `HEAD`: `git switch -c feat/<name>` |
| `leaked-secret` | `.env` or key file staged or tracked in the index | Untrack without deleting local file: `git rm --cached <file>` + rotate key |

### 4. `git-agent skills [list | install [dir]] [--target <claude|agents|both>] [--dry-run] [--force] [--json]`

Ships five portable Agent Skills under [`skills/`](skills/) that follow the `SKILL.md` standard (`name` matching `^[a-z0-9]+(-[a-z0-9]+)*$`, `description` with `"Use when ..."` trigger clause, and `<!-- git-agent-workflow-kit:managed sha256=... -->` ownership markers):

1. **[`git-repo-onboarding`](skills/git-repo-onboarding/SKILL.md)** — Pre-flight check of branch, worktrees, uncommitted state, and `.gitignore` hygiene before editing code.
2. **[`github-issue-to-pr`](skills/github-issue-to-pr/SKILL.md)** — End-to-end issue execution: task scope contract, feature branch, atomic commits, `pr-ready` check, and honest PR report.
3. **[`pr-readiness-review`](skills/pr-readiness-review/SKILL.md)** — Independent diff review checking for scope creep, weakened test assertions, silent schema/CI drift, and leaked secrets.
4. **[`git-conflict-recovery`](skills/git-conflict-recovery/SKILL.md)** — Safe conflict resolution and recovery using `restore`, `stash`, `revert -m 1`, and `reflog`.
5. **[`multi-agent-worktree`](skills/multi-agent-worktree/SKILL.md)** — Coordinating parallel coding agents in isolated `git worktree` directories with non-overlapping file scopes.

### 5. `git-agent sandbox <lab-a|lab-b> <target-dir> [--json]`

Generates deterministic local Git repositories (complete with a local bare `origin.git` remote and `workspace/` clone) for the two hands-on laboratories in MUMRO Academy Lesson 16:

- **`lab-a` (First Repository, Scope Audit & Safe PR)**: Practice diagnosing an unignored `.env.local` on `main`, switching to `feat/session-expiry`, catching an out-of-scope edit to `src/dashboard.js` with `git-agent pr-ready`, restoring it with `git restore`, and merging cleanly.
- **`lab-b` (Three AI Agents, Merge Conflict, Weakened Test & Safe Revert)**: Practice integrating three parallel agent branches (`agent-1/auth-audit`, `agent-2/dashboard-cards`, `agent-3/fix-tests`), resolving a real `UU src/auth.js` conflict, catching Agent 3's weakened test (`assert.ok(res.status)` replacing `assert.strictEqual(res.status, 403)`), and reverting a faulty merge on `main` with `git revert -m 1 HEAD`.

---

## Example Walkthrough (`lab-b` in 60 seconds)

```bash
$ npx github:RolePlayingTech/git-agent-workflow-kit sandbox lab-b ./tmp-lab-b
$ cd ./tmp-lab-b/workspace

# Inspect Agent 3's branch, where `npm test` passes despite breaking the guest 403 guard:
$ git switch agent-3/fix-tests
$ npx github:RolePlayingTech/git-agent-workflow-kit pr-ready . --base main --allow "tests/**" --strict
Git Agent PR Readiness: FAIL
  Branch -> Base : agent-3/fix-tests -> main
  Commits        : 1 ahead, 0 behind
  Diff summary   : 2 file(s) changed (+2 / -3)
  Allowed scope  : tests/** (1 out-of-scope)

Changed files:
  [M] src/auth.js (+1/-1)
  [M] tests/auth.test.js (+1/-2)

Errors (must fix before PR):
  - Out-of-scope file modified: "src/auth.js" (allowed scope: tests/**).

Warnings (review carefully):
  - Suspicious test modification in "tests/auth.test.js": removed 2 assertion(s) vs 1 added; replaced strict assertion(s) with weak/tautological check.
```

---

## Security, Limitations & Known Risks

See **[SECURITY.md](SECURITY.md)** for full details.

- **Diagnostics never mutate your repository**: `doctor`, `pr-ready`, and `recovery-plan` are strictly read-only (`GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`).
- **Heuristic test & secret detection**: `pr-ready` uses static diff heuristics to flag removed assertions, tautological checks (`toBeDefined()`, `assert.ok(res.status)`), and sensitive filenames (`.env*`, `*.pem`, `*.key`, `id_rsa`). It is a fast review aid, not a substitute for reading the diff, running a full secret scanner (such as GitHub Secret Scanning / Gitleaks), or executing independent integration tests.
- **Local checks vs. GitHub branch protection**: `git-agent` runs locally or in CI. To prevent an agent with push credentials from pushing directly to `main`, enforce **Branch Protection / Rulesets**, **Required Status Checks**, and **Required Reviews** in your GitHub repository settings.

---

## Development & Verification

```bash
npm test            # Run all 16 unit, real-Git scenario, sandbox, skill, and CLI tests
npm run doctor      # Run git-agent doctor on this repository
npm run skills:list # List all 5 built-in Agent Skills and their SHA-256 digests
```

## License

MIT © [RolePlayingTech](https://roleplayingtech.com) & [MUMRO Academy](https://academy.mumro.io). See [LICENSE](LICENSE).
