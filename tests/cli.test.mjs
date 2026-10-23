import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const cliBin = resolve(import.meta.dirname, '../bin/git-agent.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [cliBin, ...args], { encoding: 'utf8' });
}

test('CLI help and skills list return exit code 0 and valid JSON when --json is passed', () => {
  const helpRes = runCli(['--help']);
  assert.strictEqual(helpRes.status, 0);
  assert.match(helpRes.stdout, /git-agent-workflow-kit/);

  const skillsRes = runCli(['skills', 'list', '--json']);
  assert.strictEqual(skillsRes.status, 0);
  const parsed = JSON.parse(skillsRes.stdout);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.skills.length, 5);
});

test('CLI rejects unknown commands and unknown options with exit code 1', () => {
  const badCmd = runCli(['teleport']);
  assert.strictEqual(badCmd.status, 1);
  assert.match(badCmd.stderr, /Unknown command "teleport"/);

  const badFlag = runCli(['doctor', '--magic-flag', '--json']);
  assert.strictEqual(badFlag.status, 1);
  const parsed = JSON.parse(badFlag.stdout);
  assert.strictEqual(parsed.ok, false);
  assert.match(parsed.error, /Unknown option "--magic-flag"/);
});
