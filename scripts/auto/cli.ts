// CLI entry point for `openbroker auto` commands

import { parseArgs } from '../core/utils.js';
import { resolveScriptPath, listAutomations, ensureAutomationsDir } from './loader.js';
import { startAutomation, getRunningAutomations } from './runtime.js';

function printUsage() {
  console.log(`
OpenBroker Automations — event-driven trading scripts

Usage:
  openbroker auto run <script> [options]    Run an automation script
  openbroker auto list                      List available automations
  openbroker auto status                    Show running automations

Options (for run):
  --dry              Intercept write methods (no real trades)
  --verbose          Show debug output
  --id <name>        Custom automation ID (default: filename)
  --poll <ms>        Poll interval in milliseconds (default: 10000)

Scripts are loaded from:
  1. Absolute or relative path
  2. ~/.openbroker/automations/<name>.ts

Writing an automation:
  export default function(api) {
    api.on('price_change', async ({ coin, changePct }) => {
      api.log.info(\`\${coin} moved \${changePct.toFixed(2)}%\`);
    });
  }

Events: tick, price_change, funding_update, position_opened,
        position_closed, position_changed, pnl_threshold, margin_warning

Examples:
  openbroker auto run my-strategy --dry     # Test without trading
  openbroker auto run ./funding-scalp.ts    # Run from path
  openbroker auto list                      # Show available scripts
`);
}

async function runCommand(args: Record<string, string | boolean>, positional: string[]) {
  const scriptName = positional[0];
  if (!scriptName) {
    console.error('Error: script name or path required');
    console.log('Usage: openbroker auto run <script> [--dry] [--verbose]');
    process.exit(1);
  }

  const scriptPath = resolveScriptPath(scriptName);
  const dryRun = args.dry === true;
  const verbose = args.verbose === true;
  const pollIntervalMs = args.poll ? parseInt(String(args.poll), 10) : 10_000;
  const id = args.id ? String(args.id) : undefined;

  if (isNaN(pollIntervalMs) || pollIntervalMs < 1000) {
    console.error('Error: --poll must be at least 1000ms');
    process.exit(1);
  }

  const automation = await startAutomation({
    scriptPath,
    id,
    dryRun,
    verbose,
    pollIntervalMs,
  });

  // Graceful shutdown on SIGINT/SIGTERM
  const shutdown = async () => {
    console.log('\nShutting down...');
    await automation.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  await new Promise(() => {});
}

function listCommand() {
  ensureAutomationsDir();
  const automations = listAutomations();

  if (automations.length === 0) {
    console.log('No automations found in ~/.openbroker/automations/');
    console.log('\nCreate a .ts file there with:');
    console.log('  export default function(api) { ... }');
    return;
  }

  console.log('Available automations:\n');
  for (const a of automations) {
    console.log(`  ${a.name.padEnd(30)} ${a.path}`);
  }
  console.log(`\nRun with: openbroker auto run <name>`);
}

function statusCommand() {
  const running = getRunningAutomations();

  if (running.length === 0) {
    console.log('No automations running');
    return;
  }

  console.log('Running automations:\n');
  for (const a of running) {
    const uptime = Math.round((Date.now() - a.startedAt.getTime()) / 1000);
    console.log(`  ${a.id}`);
    console.log(`    Script:  ${a.scriptPath}`);
    console.log(`    Uptime:  ${uptime}s`);
    console.log(`    Polls:   ${a.pollCount}`);
    console.log(`    Events:  ${a.eventsEmitted}`);
    console.log(`    Dry run: ${a.dryRun}`);
    console.log('');
  }
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const subcommand = rawArgs[0];
  const restArgs = rawArgs.slice(1);

  // Extract positional args (non-flag args)
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < restArgs.length; i++) {
    if (restArgs[i].startsWith('--')) {
      flagArgs.push(restArgs[i]);
      // If next arg doesn't start with --, it's a flag value
      if (i + 1 < restArgs.length && !restArgs[i + 1].startsWith('--')) {
        flagArgs.push(restArgs[i + 1]);
        i++;
      }
    } else {
      positional.push(restArgs[i]);
    }
  }

  const args = parseArgs(flagArgs);

  switch (subcommand) {
    case 'run':
      await runCommand(args, positional);
      break;
    case 'list':
      listCommand();
      break;
    case 'status':
      statusCommand();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log('Run "openbroker auto --help" for usage');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
