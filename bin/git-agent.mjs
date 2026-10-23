#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatDoctorReport, runDoctor } from '../src/doctor.mjs';
import { formatPrReadyReport, runPrReady } from '../src/pr-ready.mjs';
import { buildRecoveryPlan, formatRecoveryPlan, RECOVERY_SCENARIOS } from '../src/recovery-plan.mjs';
import { createSandbox } from '../src/sandbox.mjs';
import { applySkillsInstall, listSkills, planSkillsInstall } from '../src/skills.mjs';

const COMMANDS = ['doctor', 'pr-ready', 'recovery-plan', 'skills', 'sandbox', 'help'];

export function help() {
  return `git-agent-workflow-kit: read-only Git & PR diagnostics, safe recovery plans, and Agent Skills.

Usage:
  git-agent doctor [dir] [--strict] [--json]
  git-agent pr-ready [dir] [--base <ref>] [--allow <glob>...] [--max-files <n>] [--max-lines <n>] [--gh] [--strict] [--json]
  git-agent recovery-plan [dir] [--scenario <id>] [--json]
  git-agent skills [list | install [dir]] [--target <claude|agents|both>] [--dry-run] [--force] [--json]
  git-agent sandbox <lab-a|lab-b> <target-dir> [--json]
  git-agent help

Commands:
  doctor          Inspect active branch/HEAD, uncommitted changes, conflicts, worktrees, remotes, and secret/.gitignore hygiene.
  pr-ready        Audit branch readiness for Pull Request: scope (--allow), secret leaks, conflict markers, weakened tests, and diff size.
  recovery-plan   Diagnose repository problems and print a safe, non-destructive step-by-step Git recovery plan.
  skills          List or install portable Git/GitHub Agent Skills (SKILL.md) with SHA-256 conflict detection.
  sandbox         Create a reproducible local Git practice repository for Lesson 16 hands-on labs (lab-a or lab-b).
  help            Show this help message.

Supported recovery scenarios (--scenario):
  ${RECOVERY_SCENARIOS.join(', ')}
`;
}

export function parseArgs(argv) {
  const flags = {
    strict: false,
    json: false,
    dryRun: false,
    force: false,
    gh: false,
    base: null,
    allow: [],
    maxFiles: 20,
    maxLines: 800,
    scenario: null,
    target: 'claude',
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') flags.strict = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--gh') flags.gh = true;
    else if (arg === '-h' || arg === '--help') positionals.unshift('help');
    else if (arg === '--base') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw new Error('Option --base requires a branch or commit ref.');
      flags.base = val;
    } else if (arg.startsWith('--base=')) {
      flags.base = arg.slice('--base='.length);
    } else if (arg === '--allow') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw new Error('Option --allow requires a glob pattern.');
      flags.allow.push(...val.split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith('--allow=')) {
      flags.allow.push(...arg.slice('--allow='.length).split(',').map((s) => s.trim()).filter(Boolean));
    } else if (arg === '--max-files') {
      const val = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(val) || val < 1) throw new Error('Option --max-files requires a positive integer.');
      flags.maxFiles = val;
    } else if (arg === '--max-lines') {
      const val = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(val) || val < 1) throw new Error('Option --max-lines requires a positive integer.');
      flags.maxLines = val;
    } else if (arg === '--scenario') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw new Error('Option --scenario requires a scenario name.');
      flags.scenario = val;
    } else if (arg.startsWith('--scenario=')) {
      flags.scenario = arg.slice('--scenario='.length);
    } else if (arg === '--target') {
      const val = argv[++i];
      if (!val || val.startsWith('-')) throw new Error('Option --target requires claude, agents, or both.');
      flags.target = val;
    } else if (arg.startsWith('--target=')) {
      flags.target = arg.slice('--target='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}". Run "git-agent help" for usage.`);
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals[0] || 'help';
  if (!COMMANDS.includes(command)) {
    throw new Error(`Unknown command "${command}". Try "git-agent help".`);
  }

  return { command, positionals: positionals.slice(1), flags };
}

export function run(argv = process.argv.slice(2)) {
  const { command, positionals, flags } = parseArgs(argv);

  if (command === 'help') {
    return { code: 0, text: help(), data: { ok: true, command: 'help' } };
  }

  if (command === 'doctor') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument "${positionals[1]}". Usage: git-agent doctor [dir] [--strict] [--json]`);
    }
    const dir = resolve(positionals[0] || '.');
    const report = runDoctor(dir, { strict: flags.strict });
    return {
      code: report.ok ? 0 : 1,
      text: flags.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report),
      data: report,
    };
  }

  if (command === 'pr-ready') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument "${positionals[1]}". Usage: git-agent pr-ready [dir] [options]`);
    }
    const dir = resolve(positionals[0] || '.');
    const report = runPrReady(dir, {
      base: flags.base,
      allow: flags.allow,
      maxFiles: flags.maxFiles,
      maxLines: flags.maxLines,
      gh: flags.gh,
      strict: flags.strict,
    });
    return {
      code: report.ok ? 0 : 1,
      text: flags.json ? JSON.stringify(report, null, 2) : formatPrReadyReport(report),
      data: report,
    };
  }

  if (command === 'recovery-plan') {
    if (positionals.length > 1) {
      throw new Error(`Unexpected argument "${positionals[1]}". Usage: git-agent recovery-plan [dir] [--scenario <id>] [--json]`);
    }
    const dir = resolve(positionals[0] || '.');
    const plan = buildRecoveryPlan(dir, { scenario: flags.scenario });
    return {
      code: 0,
      text: flags.json ? JSON.stringify(plan, null, 2) : formatRecoveryPlan(plan),
      data: plan,
    };
  }

  if (command === 'skills') {
    const sub = positionals[0] || 'list';
    if (sub === 'list') {
      const items = listSkills();
      const text = [
        `Git Agent Workflow Skills (${items.length}):`,
        ...items.map((s) => `  - ${s.name}: ${s.description}`),
      ].join('\n');
      return {
        code: 0,
        text: flags.json ? JSON.stringify({ ok: true, skills: items }, null, 2) : text,
        data: { ok: true, skills: items },
      };
    }
    if (sub === 'install') {
      const targetDir = resolve(positionals[1] || '.');
      const plan = planSkillsInstall(targetDir, { target: flags.target, force: flags.force });
      const hasConflicts = plan.counts.conflict > 0 && !flags.force;
      if (flags.dryRun) {
        const payload = {
          ok: !hasConflicts,
          dryRun: true,
          counts: plan.counts,
          files: plan.files.map((f) => ({
            skill: f.skill,
            path: f.relPath,
            action: f.action,
            reason: f.reason,
            ...(f.diff ? { diff: f.diff } : {}),
          })),
        };
        const lines = [
          `Dry run (nothing written) — create: ${plan.counts.create}, update: ${plan.counts.update}, unchanged: ${plan.counts.unchanged}, conflict: ${plan.counts.conflict}:`,
          ...plan.files.map((f) => `  [${f.action.padEnd(9)}] ${f.relPath} (${f.reason})`),
        ];
        return {
          code: hasConflicts ? 1 : 0,
          text: flags.json ? JSON.stringify(payload, null, 2) : lines.join('\n'),
          data: payload,
        };
      }
      if (hasConflicts) {
        const payload = {
          ok: false,
          dryRun: false,
          counts: plan.counts,
          conflicts: plan.files.filter((f) => f.action === 'conflict').map((f) => ({ path: f.relPath, reason: f.reason })),
        };
        const conflictLines = plan.files
          .filter((f) => f.action === 'conflict')
          .map((f) => `  - ${f.relPath}: ${f.reason}`);
        return {
          code: 1,
          text: flags.json
            ? JSON.stringify(payload, null, 2)
            : `Refusing to install skills; ${plan.counts.conflict} conflict(s) detected:\n${conflictLines.join('\n')}`,
          data: payload,
        };
      }
      applySkillsInstall(plan, { dryRun: false, force: flags.force });
      const written = plan.counts.create + plan.counts.update;
      const payload = {
        ok: true,
        dryRun: false,
        written,
        counts: plan.counts,
        files: plan.files.map((f) => ({ skill: f.skill, path: f.relPath, action: f.action, reason: f.reason })),
      };
      const lines = [
        written > 0
          ? `Installed ${written} skill file(s) (create: ${plan.counts.create}, update: ${plan.counts.update}, unchanged: ${plan.counts.unchanged}):`
          : `All ${plan.files.length} skill file(s) already up to date:`,
        ...plan.files.map((f) => `  [${f.action.padEnd(9)}] ${f.relPath}`),
      ];
      return {
        code: 0,
        text: flags.json ? JSON.stringify(payload, null, 2) : lines.join('\n'),
        data: payload,
      };
    }
    throw new Error(`Unknown skills subcommand "${sub}". Use "git-agent skills list" or "git-agent skills install [dir]".`);
  }

  if (command === 'sandbox') {
    const labId = positionals[0];
    const targetDir = positionals[1];
    if (!labId || !targetDir) {
      throw new Error('Usage: git-agent sandbox <lab-a|lab-b> <target-dir>');
    }
    const result = createSandbox(labId, targetDir);
    const lines = [
      `Created Git Agent Sandbox (${result.lab}) at ${result.rootDir}`,
      `  Bare remote : ${result.originDir}`,
      `  Workspace   : ${result.workspaceDir}`,
      `  Branches    : ${result.branches.join(', ')}`,
      '',
      'Next steps:',
      ...result.instructions.map((step) => `  $ ${step}`),
    ];
    return {
      code: 0,
      text: flags.json ? JSON.stringify({ ok: true, ...result }, null, 2) : lines.join('\n'),
      data: { ok: true, ...result },
    };
  }

  return { code: 0, text: help(), data: { ok: true } };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const wantJson = process.argv.slice(2).includes('--json');
  try {
    const result = run();
    if (result.text) console.log(result.text);
    process.exitCode = result.code;
  } catch (error) {
    const msg = String(error.message || error);
    if (wantJson) {
      console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      console.error(`Error: ${msg}`);
    }
    process.exitCode = 1;
  }
}
