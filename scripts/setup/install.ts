#!/usr/bin/env npx tsx
// Harness-aware OpenBroker installer.

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '../..');
const args = new Set(process.argv.slice(2));

function printUsage(): void {
  console.log(`
OpenBroker Harness Installer
============================

Usage:
  openbroker install --codex [options]
  npx openbroker@latest install --codex [options]

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
