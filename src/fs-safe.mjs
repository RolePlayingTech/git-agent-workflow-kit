import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const MARKER_PREFIX = '<!-- git-agent-workflow-kit:managed sha256=';
export const ZERO_DIGEST = '0'.repeat(64);

export function assertSafeChildPath(rootDir, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    throw new Error('Target relative path must be a non-empty string.');
  }
  if (relPath.includes('\0')) {
    throw new Error(`Unsafe null byte in path "${relPath}".`);
  }
  const normalizedRel = relPath.replace(/\\/g, '/');
  if (normalizedRel.startsWith('/') || /^[A-Za-z]:/.test(normalizedRel)) {
    throw new Error(`Path "${relPath}" must be relative to the target directory.`);
  }
  const segments = normalizedRel.split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`Path traversal ("..") is not allowed in "${relPath}".`);
  }

  const rootResolved = existsSync(rootDir) ? realpathSync(rootDir) : resolve(rootDir);
  const fullPath = resolve(rootResolved, normalizedRel);
  const relCheck = relative(rootResolved, fullPath);
  if (relCheck.startsWith('..') || isAbsolute(relCheck)) {
    throw new Error(`Resolved path "${fullPath}" escapes target root "${rootResolved}".`);
  }

  // Check every existing ancestor from rootResolved down to fullPath for symlinks/junctions
  let current = rootResolved;
  for (const part of segments.filter(Boolean)) {
    current = resolve(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symbolic link at "${current}".`);
      }
    }
  }
  return { rootResolved, fullPath, relPath: normalizedRel };
}

export function stampManagedContent(bodyWithoutMarker) {
  const clean = bodyWithoutMarker.replace(/\r\n/g, '\n').trimEnd();
  const placeholder = `${clean}\n\n${MARKER_PREFIX}${ZERO_DIGEST} -->\n`;
  const digest = createHash('sha256').update(placeholder, 'utf8').digest('hex');
  return `${clean}\n\n${MARKER_PREFIX}${digest} -->\n`;
}

export function verifyManagedContent(content) {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/<!-- git-agent-workflow-kit:managed sha256=([a-f0-9]{64}) -->/);
  if (!match) {
    return { managed: false, valid: false, digest: null };
  }
  const recorded = match[1];
  const zeroed = normalized.replace(
    `<!-- git-agent-workflow-kit:managed sha256=${recorded} -->`,
    `<!-- git-agent-workflow-kit:managed sha256=${ZERO_DIGEST} -->`
  );
  const computed = createHash('sha256').update(zeroed, 'utf8').digest('hex');
  return { managed: true, valid: computed === recorded, digest: recorded };
}

export function formatUnifiedDiff(relPath, beforeText, afterText) {
  const beforeLines = beforeText === null ? [] : beforeText.replace(/\r\n/g, '\n').split('\n');
  const afterLines = afterText.replace(/\r\n/g, '\n').split('\n');
  if (beforeText !== null && beforeLines.join('\n') === afterLines.join('\n')) {
    return '';
  }
  const header = [
    `--- ${beforeText === null ? '/dev/null' : `a/${relPath}`}`,
    `+++ b/${relPath}`,
    `@@ -${beforeText === null ? '0,0' : `1,${beforeLines.length}`} +1,${afterLines.length} @@`,
  ];
  const body = [
    ...beforeLines.map((l) => `-${l}`),
    ...afterLines.map((l) => `+${l}`),
  ];
  return [...header, ...body].join('\n');
}

export function globToRegExp(globPattern) {
  const normalized = globPattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let regexStr = '^';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 3;
          continue;
        }
        regexStr += '.*';
        i += 2;
        continue;
      }
      regexStr += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i += 1;
      continue;
    }
    if ('+^$?.()|[]{}\\'.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
    i += 1;
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export function matchesAnyGlob(filePath, patterns) {
  const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  return patterns.some((pattern) => globToRegExp(pattern).test(norm));
}
