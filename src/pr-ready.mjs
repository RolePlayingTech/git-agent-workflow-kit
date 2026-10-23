import { spawnSync } from 'node:child_process';
import { matchesAnyGlob } from './fs-safe.mjs';
import {
  classifyGovernanceOrRiskPath,
  classifySensitivePath,
  inspectRepoContext,
  runGit,
  sanitizeGitError,
} from './git.mjs';

const TEST_FILE_REGEX = /(^|\/)(tests?|__tests__)\/|(\.test|\.spec)\.[cm]?[jt]sx?$/i;
const ASSERTION_REGEX = /\b(expect\s*\(|assert\s*\(|assert\.[a-zA-Z]+|should\.)/;
const STRICT_ASSERTION_REGEX = /\b(toBe|toEqual|toStrictEqual|strictEqual|deepStrictEqual|toThrow|rejects)\s*\(/;
const WEAK_ASSERTION_REGEX = /\b(toBeDefined\s*\(\s*\)|toBeTruthy\s*\(\s*\)|expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*true\s*\)|assert\.ok\s*\(\s*[a-zA-Z0-9_$.]+\.status\s*\))/;
const SKIPPED_TEST_REGEX = /\b(it|test|describe)\.(skip|only|todo)\s*\(/;

export function resolveBaseRef(repoRoot, explicitBase) {
  if (explicitBase) {
    const verify = runGit(repoRoot, ['rev-parse', '--verify', `${explicitBase}^{commit}`]);
    if (verify.status !== 0) {
      throw new Error(`Base ref "${explicitBase}" could not be resolved in ${repoRoot}.`);
    }
    return explicitBase;
  }
  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  for (const ref of candidates) {
    const res = runGit(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (res.status === 0) return ref;
  }
  throw new Error('Could not auto-detect a base branch (tried origin/main, main, origin/master, master). Pass --base <ref>.');
}

function inspectTestDiff(repoRoot, baseRef, filePath) {
  const diffRes = runGit(repoRoot, ['diff', '-U0', `${baseRef}...HEAD`, '--', filePath]);
  if (diffRes.status !== 0) {
    return {
      path: filePath,
      diffFailed: true,
      exitCode: diffRes.status,
      detail: sanitizeGitError(diffRes.stderr || diffRes.stdout),
    };
  }

  let removedAssertions = 0;
  let addedAssertions = 0;
  let removedStrict = 0;
  let addedStrict = 0;
  let addedWeak = 0;
  let addedSkips = 0;

  for (const line of diffRes.stdout.split('\n')) {
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('@@')) continue;
    if (line.startsWith('-')) {
      const code = line.slice(1);
      if (ASSERTION_REGEX.test(code)) removedAssertions += 1;
      if (STRICT_ASSERTION_REGEX.test(code)) removedStrict += 1;
    } else if (line.startsWith('+')) {
      const code = line.slice(1);
      if (ASSERTION_REGEX.test(code)) addedAssertions += 1;
      if (STRICT_ASSERTION_REGEX.test(code)) addedStrict += 1;
      if (WEAK_ASSERTION_REGEX.test(code)) addedWeak += 1;
      if (SKIPPED_TEST_REGEX.test(code)) addedSkips += 1;
    }
  }

  const weakened = (removedStrict > addedStrict && addedWeak > 0) || removedAssertions > addedAssertions || addedSkips > 0;
  if (!weakened) return null;

  return {
    path: filePath,
    removedAssertions,
    addedAssertions,
    removedStrict,
    addedStrict,
    addedWeak,
    addedSkips,
  };
}

function queryGhPrStatus(repoRoot) {
  const res = spawnSync(
    'gh',
    ['pr', 'view', '--json', 'number,title,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,url'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      timeout: 10000,
    }
  );
  if (res.error) {
    return { available: false, error: `GitHub CLI (gh) could not be executed: ${res.error.message}` };
  }
  if (res.status !== 0) {
    return { available: false, error: (res.stderr || res.stdout || 'No open PR or gh not authenticated').trim() };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return { available: true, pr: parsed };
  } catch (err) {
    return { available: false, error: `Failed to parse gh pr view JSON: ${err.message}` };
  }
}

export function runPrReady(dir, options = {}) {
  const ctx = inspectRepoContext(dir);
  const baseRef = resolveBaseRef(ctx.repoRoot, options.base);
  const allowPatterns = Array.isArray(options.allow) ? options.allow.filter(Boolean) : [];
  const maxFiles = typeof options.maxFiles === 'number' ? options.maxFiles : 20;
  const maxLines = typeof options.maxLines === 'number' ? options.maxLines : 800;
  const strict = Boolean(options.strict);

  const errors = [];
  const warnings = [];

  // 1. Branch checks
  const cleanBaseName = baseRef.replace(/^origin\//, '');
  if (ctx.detached) {
    errors.push('Repository is in detached HEAD state. Attach a named feature branch before opening a PR.');
  } else if (ctx.branch === baseRef || ctx.branch === cleanBaseName || ctx.isProtectedBranch) {
    errors.push(`Active branch "${ctx.branch}" is a protected/base branch. Work must be on a dedicated feature branch.`);
  }

  // 2. Working tree cleanliness
  if (ctx.inProgress) {
    errors.push(`In-progress Git ${ctx.inProgress.operation} must be completed or aborted before PR review.`);
  }
  if (ctx.status.conflicted.length > 0) {
    errors.push(`Unresolved merge conflicts (${ctx.status.conflicted.length}) in working tree.`);
  }
  if (ctx.status.staged.length > 0 || ctx.status.unstaged.length > 0) {
    errors.push(
      `Working tree has uncommitted changes (staged: ${ctx.status.staged.length}, unstaged: ${ctx.status.unstaged.length}). Commit, restore, or stash them first.`
    );
  }
  if (ctx.status.untracked.length > 0) {
    warnings.push(
      `Working tree has ${ctx.status.untracked.length} untracked file(s): ${ctx.status.untracked.slice(0, 5).join(', ')}.`
    );
  }

  // 3. Ahead / behind, merge-base & diff stats (fail closed on any Git subprocess error)
  const aheadRes = runGit(ctx.repoRoot, ['rev-list', '--count', `${baseRef}..HEAD`]);
  const behindRes = runGit(ctx.repoRoot, ['rev-list', '--count', `HEAD..${baseRef}`]);
  if (aheadRes.status !== 0) {
    const detail = sanitizeGitError(aheadRes.stderr || aheadRes.stdout);
    errors.push(
      `Failed to count commits ahead for "${baseRef}..HEAD" (git rev-list exited ${aheadRes.status}${detail ? `: ${detail}` : ''}).`
    );
  }
  if (behindRes.status !== 0) {
    const detail = sanitizeGitError(behindRes.stderr || behindRes.stdout);
    errors.push(
      `Failed to count commits behind for "HEAD..${baseRef}" (git rev-list exited ${behindRes.status}${detail ? `: ${detail}` : ''}).`
    );
  }
  const commitsAhead = aheadRes.status === 0 ? Number.parseInt(aheadRes.stdout.trim(), 10) || 0 : 0;
  const commitsBehind = behindRes.status === 0 ? Number.parseInt(behindRes.stdout.trim(), 10) || 0 : 0;

  if (aheadRes.status === 0 && commitsAhead === 0) {
    errors.push(`Branch "${ctx.branch || 'HEAD'}" has 0 commits ahead of "${baseRef}".`);
  }
  if (behindRes.status === 0 && commitsBehind > 0) {
    warnings.push(`Branch is ${commitsBehind} commit(s) behind "${baseRef}".`);
  }

  const mergeBaseRes = runGit(ctx.repoRoot, ['merge-base', baseRef, 'HEAD']);
  const mergeBase = mergeBaseRes.status === 0 ? mergeBaseRes.stdout.trim() : null;
  if (mergeBaseRes.status !== 0 || !mergeBase) {
    const detail = sanitizeGitError(mergeBaseRes.stderr || mergeBaseRes.stdout);
    errors.push(
      `Cannot compute merge base between "${baseRef}" and HEAD (branches have unrelated histories or missing shallow commits; git merge-base exited ${mergeBaseRes.status}${detail ? `: ${detail}` : ''}).`
    );
  }

  const nameStatusRes = runGit(ctx.repoRoot, ['diff', '--name-status', `${baseRef}...HEAD`]);
  if (nameStatusRes.status !== 0) {
    const detail = sanitizeGitError(nameStatusRes.stderr || nameStatusRes.stdout);
    errors.push(
      `Failed to compute changed file statuses ("git diff --name-status ${baseRef}...HEAD" exited ${nameStatusRes.status}${detail ? `: ${detail}` : ''}).`
    );
  }

  const numstatRes = runGit(ctx.repoRoot, ['diff', '--numstat', `${baseRef}...HEAD`]);
  if (numstatRes.status !== 0) {
    const detail = sanitizeGitError(numstatRes.stderr || numstatRes.stdout);
    errors.push(
      `Failed to compute diff line stats ("git diff --numstat ${baseRef}...HEAD" exited ${numstatRes.status}${detail ? `: ${detail}` : ''}).`
    );
  }

  const numstatMap = new Map();
  let totalInsertions = 0;
  let totalDeletions = 0;

  if (numstatRes.status === 0) {
    for (const line of numstatRes.stdout.split('\n').filter(Boolean)) {
      const [insRaw, delRaw, ...pathParts] = line.split('\t');
      const rawPath = pathParts.join('\t').trim();
      const ins = insRaw === '-' ? 0 : Number.parseInt(insRaw, 10) || 0;
      const del = delRaw === '-' ? 0 : Number.parseInt(delRaw, 10) || 0;
      totalInsertions += ins;
      totalDeletions += del;
      numstatMap.set(rawPath, { insertions: ins, deletions: del });
    }
  }

  const changedFiles = [];
  if (nameStatusRes.status === 0) {
    for (const line of nameStatusRes.stdout.split('\n').filter(Boolean)) {
      const parts = line.split('\t');
      const status = parts[0].trim();
      const filePath = (parts[parts.length - 1] || '').trim().replace(/\\/g, '/');
      const stats = numstatMap.get(filePath) || { insertions: 0, deletions: 0 };
      changedFiles.push({ status, path: filePath, ...stats });
    }
  }

  // 4. Scope enforcement (--allow)
  const outOfScopeFiles = [];
  if (allowPatterns.length > 0) {
    for (const file of changedFiles) {
      if (!matchesAnyGlob(file.path, allowPatterns)) {
        outOfScopeFiles.push(file.path);
        errors.push(`Out-of-scope file modified: "${file.path}" (allowed scope: ${allowPatterns.join(', ')}).`);
      }
    }
  }

  // 5. Sensitive files & governance paths in diff
  const sensitiveInDiff = [];
  const governanceFilesInDiff = [];
  const testIntegrityFindings = [];

  for (const file of changedFiles) {
    if (!file.status.startsWith('D')) {
      const sensitive = classifySensitivePath(file.path);
      if (sensitive) {
        sensitiveInDiff.push(sensitive);
        errors.push(`Sensitive file in PR diff: "${file.path}" (${sensitive.category}).`);
      }
    }
    const gov = classifyGovernanceOrRiskPath(file.path);
    if (gov) {
      governanceFilesInDiff.push(gov);
      warnings.push(`High-attention file modified: "${file.path}" (${gov.category} — ${gov.reason}).`);
    }
    if (TEST_FILE_REGEX.test(file.path)) {
      if (file.status.startsWith('D')) {
        testIntegrityFindings.push({ path: file.path, deletedFile: true });
        warnings.push(`Test file deleted in PR diff: "${file.path}". Verify test coverage was not silently removed.`);
      } else {
        const finding = inspectTestDiff(ctx.repoRoot, baseRef, file.path);
        if (finding && finding.diffFailed) {
          errors.push(
            `Failed to inspect test diff for "${file.path}" ("git diff -U0 ${baseRef}...HEAD -- ${file.path}" exited ${finding.exitCode}${finding.detail ? `: ${finding.detail}` : ''}).`
          );
        } else if (finding) {
          testIntegrityFindings.push(finding);
          const detailParts = [];
          if (finding.removedAssertions > finding.addedAssertions) {
            detailParts.push(`removed ${finding.removedAssertions} assertion(s) vs ${finding.addedAssertions} added`);
          }
          if (finding.removedStrict > finding.addedStrict && finding.addedWeak > 0) {
            detailParts.push('replaced strict assertion(s) with weak/tautological check');
          }
          if (finding.addedSkips > 0) {
            detailParts.push(`added ${finding.addedSkips} skipped/todo test(s)`);
          }
          warnings.push(`Suspicious test modification in "${file.path}": ${detailParts.join('; ')}.`);
        }
      }
    }
  }

  // 6. Conflict markers in diff
  const fullDiffRes = runGit(ctx.repoRoot, ['diff', `${baseRef}...HEAD`]);
  if (fullDiffRes.status !== 0) {
    const detail = sanitizeGitError(fullDiffRes.stderr || fullDiffRes.stdout);
    errors.push(
      `Failed to scan diff for conflict markers ("git diff ${baseRef}...HEAD" exited ${fullDiffRes.status}${detail ? `: ${detail}` : ''}).`
    );
  } else {
    const markerLines = fullDiffRes.stdout
      .split('\n')
      .filter((line) => /^\+(<{7} |={7}$|>{7} )/.test(line));
    if (markerLines.length > 0) {
      errors.push(`Diff between "${baseRef}" and HEAD contains ${markerLines.length} conflict marker line(s).`);
    }
  }

  // 7. Size budget
  const totalLinesChanged = totalInsertions + totalDeletions;
  if (changedFiles.length > maxFiles) {
    warnings.push(`PR touches ${changedFiles.length} files (exceeds budget of ${maxFiles} files). Consider splitting the PR.`);
  }
  if (totalLinesChanged > maxLines) {
    warnings.push(`PR changes ${totalLinesChanged} lines (+${totalInsertions} / -${totalDeletions}, exceeds budget of ${maxLines} lines).`);
  }

  // 8. Optional GitHub CLI
  let githubPr = null;
  if (options.gh) {
    githubPr = queryGhPrStatus(ctx.repoRoot);
    if (!githubPr.available) {
      warnings.push(`GitHub CLI (--gh): ${githubPr.error}`);
    }
  }

  const ok = errors.length === 0 && (!strict || warnings.length === 0);
  const statusLabel = errors.length > 0 ? 'FAIL' : warnings.length > 0 ? (strict ? 'FAIL' : 'WARN') : 'PASS';

  return {
    ok,
    status: statusLabel,
    strict,
    branch: ctx.branch,
    headSha: ctx.headSha,
    baseRef,
    mergeBase,
    commitsAhead,
    commitsBehind,
    diff: {
      filesChanged: changedFiles.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
      totalLinesChanged,
      files: changedFiles,
    },
    scope: {
      allowPatterns,
      outOfScopeFiles,
    },
    findings: {
      sensitiveInDiff,
      governanceFilesInDiff,
      testIntegrityFindings,
    },
    githubPr,
    errors,
    warnings,
  };
}

export function formatPrReadyReport(report) {
  const lines = [
    `Git Agent PR Readiness: ${report.status}`,
    `  Branch -> Base : ${report.branch || 'DETACHED'} (${report.headSha || 'none'}) -> ${report.baseRef}`,
    `  Commits        : ${report.commitsAhead} ahead, ${report.commitsBehind} behind`,
    `  Diff summary   : ${report.diff.filesChanged} file(s) changed (+${report.diff.insertions} / -${report.diff.deletions})`,
  ];

  if (report.scope.allowPatterns.length > 0) {
    lines.push(
      `  Allowed scope  : ${report.scope.allowPatterns.join(', ')} (${report.scope.outOfScopeFiles.length === 0 ? 'all files in scope' : `${report.scope.outOfScopeFiles.length} out-of-scope`})`
    );
  }

  if (report.diff.files.length > 0) {
    lines.push('', 'Changed files:');
    for (const f of report.diff.files) {
      lines.push(`  [${f.status}] ${f.path} (+${f.insertions}/-${f.deletions})`);
    }
  }

  if (report.githubPr && report.githubPr.available) {
    const pr = report.githubPr.pr;
    lines.push(
      '',
      `GitHub PR #${pr.number} (${pr.state}${pr.isDraft ? ', DRAFT' : ''}): ${pr.title}`,
      `  Review decision: ${pr.reviewDecision || 'NONE'} | Merge state: ${pr.mergeStateStatus || 'UNKNOWN'}`,
      `  URL: ${pr.url}`
    );
  }

  if (report.errors.length > 0) {
    lines.push('', 'Errors (must fix before PR):');
    for (const err of report.errors) lines.push(`  - ${err}`);
  }
  if (report.warnings.length > 0) {
    lines.push('', 'Warnings (review carefully):');
    for (const warn of report.warnings) lines.push(`  - ${warn}`);
  }
  return lines.join('\n');
}
