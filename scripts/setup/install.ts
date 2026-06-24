#!/usr/bin/env npx tsx
// Harness-aware OpenBroker installer.

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import {
  INSTALLABLE_PACKAGES,
  packageSpec,
  resolveInstallablePackage,
} from './package-catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../..');
const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);

function positionalArgs(): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === '--tag') {
      index++;
      continue;
    }
    if (!arg.startsWith('-')) positionals.push(arg);
  }
  return positionals;
}

function optionValue(flag: string): string | null {
  const index = rawArgs.indexOf(flag);
  if (index < 0) return null;
  const value = rawArgs[index + 1];
  if (!value || value.startsWith('-')) fail(`${flag} requires a value`);
  return value;
}

function printUsage(): void {
  console.log(`
OpenBroker Installer
====================

Usage:
  openbroker install <package> [--tag <version>] [--dry]
  openbroker install --list
  openbroker install --codex [options]
  npx openbroker@latest install --codex [options]

Companion packages:
  monitoring    Install the local automation dashboard
  extended      Install the Extended Exchange CLI

Package options:
  --tag <tag>   Install a release tag or exact version (default: latest)
  --dry         Print the npm command without installing
  --list        List supported companion packages

Harnesses:
  --codex       Install the OpenBroker skill for Codex

Options:
  --skip-cli    Do not install the persistent global CLI
  --skip-setup  Install files without starting API-wallet onboarding
  --help        Show this help

The default Codex flow installs the global CLI, writes the skill under
$CODEX_HOME/skills/openbroker (default: ~/.codex/skills/openbroker), and starts
restricted API-wallet onboarding.
`);
}

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function assertOpenBrokerSkill(skillPath: string): void {
  if (!fs.existsSync(skillPath)) return;

  const existing = fs.readFileSync(skillPath, 'utf8');
  if (!/^name:\s*openbroker\s*$/m.test(existing)) {
    fail(`refusing to overwrite unrelated skill at ${skillPath}`);
  }
}

function copyManagedFile(source: string, destination: string): void {
  if (!fs.existsSync(source)) {
    fail(`packaged installer asset is missing: ${source}`);
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o644);
}

function installCodexSkill(): string {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const destination = path.join(codexHome, 'skills', 'openbroker');
  const skillPath = path.join(destination, 'SKILL.md');

  assertOpenBrokerSkill(skillPath);
  copyManagedFile(path.join(packageRoot, 'SKILL.md'), skillPath);
  copyManagedFile(
    path.join(packageRoot, 'agents', 'openai.yaml'),
    path.join(destination, 'agents', 'openai.yaml'),
  );

  console.log(`✅ Codex skill installed: ${destination}`);
  return destination;
}

function installGlobalCli(): void {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  console.log('\nInstalling the persistent OpenBroker CLI...');
  const result = spawnSync(npmCommand, ['install', '-g', 'openbroker@latest'], {
    stdio: 'inherit',
  });

  if (result.error) {
    fail(`could not start npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      'global CLI installation failed. Fix the npm permission error, then rerun with --skip-cli.',
    );
  }
}

function printInstallablePackages(): void {
  console.log('Installable OpenBroker packages:\n');
  for (const entry of INSTALLABLE_PACKAGES) {
    console.log(`  ${entry.key.padEnd(12)} ${entry.packageName.padEnd(26)} ${entry.description}`);
  }
  console.log('\nInstall or upgrade with: openbroker install <package>');
}

function installCompanionPackage(target: string): void {
  const entry = resolveInstallablePackage(target);
  if (!entry) {
    printInstallablePackages();
    fail(`unknown installable package: ${target}`);
  }

  const allowedFlags = new Set(['--tag', '--dry']);
  const unsupported = rawArgs.filter((arg, index) => (
    arg.startsWith('-')
    && !allowedFlags.has(arg)
    && rawArgs[index - 1] !== '--tag'
  ));
  if (unsupported.length > 0) fail(`unsupported package option: ${unsupported[0]}`);

  const tag = optionValue('--tag') ?? 'latest';
  let spec: string;
  try {
    spec = packageSpec(entry, tag);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmArgs = ['install', '--global', spec];

  console.log(`OpenBroker — Install ${entry.key}`);
  console.log('================================\n');
  console.log(`Package: ${spec}`);
  console.log(`Command: ${npmCommand} ${npmArgs.join(' ')}`);

  if (args.has('--dry')) {
    console.log('\nDry run only; nothing was installed.');
    return;
  }

  const result = spawnSync(npmCommand, npmArgs, { stdio: 'inherit' });
  if (result.error) fail(`could not start npm: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`installation failed for ${entry.packageName}; resolve the npm error and retry`);
  }

  console.log(`\n✅ ${entry.packageName} installed successfully.`);
  console.log(`Available command: ${entry.command}`);
  console.log('\nNext steps:');
  for (const step of entry.nextSteps) console.log(`  ${step}`);
}

function runApiWalletSetup(): void {
  const onboardPath = path.join(packageRoot, 'scripts', 'setup', 'onboard.ts');

  console.log('\nStarting restricted API-wallet onboarding...\n');
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', onboardPath, '--api-wallet'],
    {
      stdio: 'inherit',
      cwd: packageRoot,
      env: process.env,
    },
  );

  if (result.error) {
    fail(`could not start onboarding: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail('API-wallet onboarding did not complete. Rerun `openbroker setup --api-wallet`.');
  }
}

function main(): void {
  if (args.has('--help') || args.has('-h')) {
    printUsage();
    return;
  }

  if (args.has('--list')) {
    printInstallablePackages();
    return;
  }

  const positionals = positionalArgs();
  if (positionals.length > 0) {
    if (positionals.length > 1) fail(`expected one package name, received: ${positionals.join(' ')}`);
    if (args.has('--codex')) fail('choose either a companion package or the --codex harness installer');
    installCompanionPackage(positionals[0]);
    return;
  }

  if (!args.has('--codex')) {
    printUsage();
    fail('choose a supported harness flag such as --codex');
  }

  console.log('OpenBroker — Codex Installation');
  console.log('================================\n');

  installCodexSkill();

  if (!args.has('--skip-cli')) {
    installGlobalCli();
  }

  if (!args.has('--skip-setup')) {
    runApiWalletSetup();
  }

  console.log('\n✅ OpenBroker installation complete.');
  console.log('Restart Codex or start a new thread, then invoke $openbroker.');
}

main();
