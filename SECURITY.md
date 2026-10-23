# Security Policy & Operational Guarantees

`git-agent-workflow-kit` is designed for developers and AI coding agents operating on real repositories where accidental history rewrites, silent scope creep, or leaked credentials can cause permanent damage.

## 1. Read-Only Diagnostics by Default

All diagnostic and planning commands (`doctor`, `pr-ready`, `recovery-plan`, `skills list`, and `skills install --dry-run`) are **strictly read-only**:

- They inspect repository state using non-mutating Git plumbing and porcelain queries (`git status --porcelain=v1 -b`, `git rev-parse`, `git worktree list --porcelain`, `git diff`, `git log`, `git reflog`).
- They set `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` so background status checks neither hang waiting for interactive credentials nor contend for `.git/index.lock` while another process or IDE is running.
- They **never** execute `git reset --hard`, `git push --force`, `git clean`, `git checkout -f`, `git branch -D`, `git rebase`, `git merge`, or `git commit` automatically.

## 2. Explicit Boundaries for File-Writing Commands

Only two subcommands write to disk, and both enforce strict safety checks:

1. **`git-agent skills install [dir]`**:
   - Writes `SKILL.md` files only inside `.claude/skills/<name>/SKILL.md` and/or `.agents/skills/<name>/SKILL.md` within the target directory.
   - Rejects any path traversal (`..`), null bytes, or symlinked parent directories (`lstatSync`).
   - Embeds a deterministic `<!-- git-agent-workflow-kit:managed sha256=... -->` marker. If a target `SKILL.md` was created by hand or edited after generation, `skills install` reports a `[conflict]` and refuses to overwrite it unless `--force` is explicitly passed.
   - Supports `--dry-run` to preview `create` / `update` / `unchanged` / `conflict` actions and unified diffs without touching the filesystem.

2. **`git-agent sandbox <lab-a|lab-b> <target-dir>`**:
   - Creates a self-contained practice repository for hands-on Git training.
   - Refuses to run if `<target-dir>` is a non-empty directory or lies inside an existing Git working tree unless `<target-dir>` is an empty directory specifically created for the sandbox.

## 3. Secret & Credential Hygiene

- **Zero secret value logging**: When `doctor` or `pr-ready` detects a sensitive file (such as `.env`, `.env.local`, `*.pem`, `*.key`, `id_rsa`, or `credentials.json`) or a suspicious credential header in a diff, it reports **only the relative file path and rule category**. It never prints or logs the secret value itself. Any Git subprocess error string surfaced by `pr-ready` is passed through `sanitizeGitError()` to redact embedded URL credentials (`https://user:token@...`) and token prefixes (`ghp_*`, `github_pat_*`, `glpat-*`).
- **Fail-closed diff & merge-base verification**: `pr-ready` checks the exit status of every underlying Git query (`rev-list`, `merge-base`, `diff --name-status`, `diff --numstat`, per-file test diff, and full conflict-marker diff). If any subprocess fails (for example, `fatal: no merge base` on unrelated histories or missing shallow commits), `pr-ready` records an explicit error and exits nonzero (`FAIL`) rather than proceeding with an empty file list.
- **Scope of guarantees**: `doctor` and `pr-ready` verify repository state, branch isolation, file-scope rules, and static diff hygiene. They do not execute application tests or replace GitHub server-side Branch Protection / Rulesets.
- **No GitHub token required for local workflows**: `doctor`, `pr-ready`, `recovery-plan`, `skills`, and `sandbox` run entirely offline against local Git metadata.
- **Optional `--gh` integration**: `git-agent pr-ready --gh` invokes the official GitHub CLI (`gh pr view`) only when `--gh` is explicitly passed. It performs a single read-only query (`number`, `state`, `reviewDecision`, `mergeStateStatus`, `statusCheckRollup`, `url`) and requires only read access to pull requests (`repo` or `pull_requests:read`).

## 4. Reporting a Vulnerability

If you discover a security issue or path-safety bug in `git-agent-workflow-kit`, please open an issue or contact RolePlayingTech via [https://roleplayingtech.com](https://roleplayingtech.com) or [https://mumro.io](https://mumro.io).
