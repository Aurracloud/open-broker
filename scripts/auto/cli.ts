// CLI entry point for `openbroker auto` commands

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { parseArgs } from '../core/utils.js';
import { resolveScriptPath, resolveExamplePath, listAutomations, listExamples, loadExampleConfigs, ensureAutomationsDir } from './loader.js';
import { startAutomation, getRunningAutomations, getRegisteredAutomations } from './runtime.js';
import { unregisterAutomation, cleanRegistry } from './registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printUsage() {
  console.log(`
OpenBroker Automations — event-driven trading scripts

Usage:
  openbroker auto run <script> [options]    Run an automation script
  openbroker auto run --example <name>      Run a bundled example automation
  openbroker auto report <id>               Read the local audit report for an automation
  openbroker auto examples                  List bundled example automations
  openbroker auto stop <id>                 Unregister an automation (won't restart)
  openbroker auto list                      List available automations
  openbroker auto status                    Show running automations
  openbroker auto clean                     Remove stale entries from registry

Options (for run):
  --example <name>   Run a bundled example (dca, grid, funding-arb, mm-spread, mm-maker)
  --set key=value    Set config values (repeatable, auto-parses numbers/booleans)
  --dry              Intercept write methods (no real trades)
  --verbose          Show debug output
  --id <name>        Custom automation ID (default: filename)
  --poll <ms>        Poll interval in milliseconds (default: 10000)
  --no-ws            Disable WebSocket; fall back to REST-only polling

Scripts are loaded from:
  1. Absolute or relative path
  2. ~/.openbroker/automations/<name>.ts
  3. Bundled examples (via --example)

Writing an automation:
  export default function(api) {
    api.on('price_change', async ({ coin, changePct }) => {
      api.log.info(\`\${coin} moved \${changePct.toFixed(2)}%\`);
    });
  }

Events: tick, price_change, funding_update, position_opened,
        position_closed, position_changed, pnl_threshold, margin_warning

Examples:
  openbroker auto run --example dca --set coin=BTC --set amount=50 --dry
  openbroker auto run --example grid --set coin=ETH --set lower=3000 --set upper=4000
  openbroker auto run my-strategy --dry
  openbroker auto report hype-mm-v2-live-r4
  openbroker auto examples
`);
}

/** Parse --set key=value flags from raw args, return parsed config object */
function parseSetFlags(rawArgs: string[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--set' && i + 1 < rawArgs.length) {
      const pair = rawArgs[i + 1];
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) {
        console.error(`Error: --set requires key=value format, got: ${pair}`);
        process.exit(1);
      }
      const key = pair.slice(0, eqIdx);
      const raw = pair.slice(eqIdx + 1);
      const isHexLike = /^0x[0-9a-fA-F]+$/.test(raw);
      const isDecimalLike = /^-?(?:\d+|\d+\.\d+|\.\d+)$/.test(raw);

      // Auto-parse numbers and booleans
      if (raw === 'true') config[key] = true;
      else if (raw === 'false') config[key] = false;
      else if (!isHexLike && isDecimalLike) config[key] = Number(raw);
      else config[key] = raw;

      i++; // skip the value
    }
  }

  return config;
}

/** Strip --set key=value pairs from raw args so parseArgs doesn't see them */
function stripSetFlags(rawArgs: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === '--set' && i + 1 < rawArgs.length) {
      i++; // skip --set and its value
    } else {
      result.push(rawArgs[i]);
    }
  }
  return result;
}

async function runCommand(args: Record<string, string | boolean>, positional: string[], initialState: Record<string, unknown>) {
  const exampleName = args.example ? String(args.example) : undefined;
  const scriptName = positional[0];

  if (!scriptName && !exampleName) {
    console.error('Error: script name or path required (or use --example <name>)');
    console.log('Usage: openbroker auto run <script> [--dry] [--verbose]');
    console.log('       openbroker auto run --example <name> [--set key=value] [--dry]');
    process.exit(1);
  }

  const scriptPath = exampleName ? resolveExamplePath(exampleName) : resolveScriptPath(scriptName!);
  const dryRun = args.dry === true;
  const verbose = args.verbose === true;
  const useWebSocket = args['no-ws'] !== true;
  const pollIntervalMs = args.poll ? parseInt(String(args.poll), 10) : undefined;
  const id = args.id ? String(args.id) : undefined;

  if (args.testnet === true) {
    process.env.HYPERLIQUID_NETWORK = 'testnet';
  } else if (args.mainnet === true) {
    process.env.HYPERLIQUID_NETWORK = 'mainnet';
  }

  if (pollIntervalMs !== undefined && (isNaN(pollIntervalMs) || pollIntervalMs < 1000)) {
    console.error('Error: --poll must be at least 1000ms');
    process.exit(1);
  }

  // Resolve OpenClaw gateway env vars here (no network code in this file)
  // so the runtime stays clean of process.env reads next to fetch() calls.
  const envHooksToken = process.env.OPENCLAW_HOOKS_TOKEN;
  const envGatewayPortStr = process.env.OPENCLAW_GATEWAY_PORT;
  const envGatewayPort = envGatewayPortStr ? parseInt(envGatewayPortStr, 10) : undefined;

  const automation = await startAutomation({
    scriptPath,
    id,
    dryRun,
    verbose,
    pollIntervalMs,
    useWebSocket,
    initialState: Object.keys(initialState).length > 0 ? initialState : undefined,
    hooksToken: envHooksToken,
    gatewayPort: envGatewayPort && !isNaN(envGatewayPort) ? envGatewayPort : undefined,
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

async function examplesCommand() {
  const configs = await loadExampleConfigs();
  const names = Object.keys(configs);

  if (names.length === 0) {
    console.log('No bundled examples found.');
    return;
  }

  console.log('Bundled example automations:\n');
  for (const name of names) {
    const cfg = configs[name];
    console.log(`  ${name}`);
    console.log(`    ${cfg.description}\n`);

    console.log(`    Config (--set key=value):`);
    for (const [key, field] of Object.entries(cfg.fields)) {
      const def = JSON.stringify(field.default);
      console.log(`      ${key.padEnd(14)} ${field.type.padEnd(8)} ${field.description} (default: ${def})`);
    }
    console.log('');
  }

  console.log(`Run with: openbroker auto run --example <name> [--set key=value] [--dry]`);
  console.log('Copy to ~/.openbroker/automations/ to customize.');
}

function listCommand() {
  ensureAutomationsDir();
  const automations = listAutomations();
  const examples = listExamples();

  if (automations.length === 0 && examples.length === 0) {
    console.log('No automations found in ~/.openbroker/automations/');
    console.log('\nCreate a .ts file there with:');
    console.log('  export default function(api) { ... }');
    console.log('\nOr run a bundled example: openbroker auto examples');
    return;
  }

  if (automations.length > 0) {
    console.log('User automations (~/.openbroker/automations/):\n');
    for (const a of automations) {
      console.log(`  ${a.name.padEnd(30)} ${a.path}`);
    }
    console.log(`\nRun with: openbroker auto run <name>`);
  }

  if (examples.length > 0) {
    if (automations.length > 0) console.log('');
    console.log(`${examples.length} bundled examples available — run: openbroker auto examples`);
  }
}

function statusCommand() {
  // Show in-process automations (if any running in this process)
  const inProcess = getRunningAutomations();

  // Show all registered automations from file-based registry (cross-process)
  const registered = getRegisteredAutomations();

  if (inProcess.length === 0 && registered.length === 0) {
    console.log('No automations running');
    return;
  }

  // Show in-process automations with live stats
  if (inProcess.length > 0) {
    console.log('Running in this process:\n');
    for (const a of inProcess) {
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

  // Show all registered automations (may include ones from other processes)
  const external = registered.filter(
    r => !inProcess.some(ip => ip.id === r.id),
  );

  if (external.length > 0) {
    if (inProcess.length > 0) console.log('Other processes:\n');
    else console.log('Registered automations:\n');

    for (const a of external) {
      const uptime = a.status === 'running'
        ? `${Math.round((Date.now() - new Date(a.startedAt).getTime()) / 1000)}s`
        : '-';
      console.log(`  ${a.id}`);
      console.log(`    Script:  ${a.scriptPath}`);
      console.log(`    Status:  ${a.status}${a.error ? ` (${a.error})` : ''}`);
      console.log(`    PID:     ${a.pid}`);
      console.log(`    Uptime:  ${uptime}`);
      console.log(`    Dry run: ${a.dryRun}`);
      console.log('');
    }
  }
}

function stopCommand(positional: string[]) {
  const id = positional[0];
  if (!id) {
    console.error('Error: automation ID required');
    console.log('Usage: openbroker auto stop <id>');
    process.exit(1);
  }

  // Check if running in this process
  const inProcess = getRunningAutomations();
  const running = inProcess.find(a => a.id === id);
  if (running) {
    running.stop().then(() => {
      console.log(`Stopped and unregistered: ${id}`);
    });
    return;
  }

  // Otherwise just remove from file registry (prevents restart)
  unregisterAutomation(id);
  console.log(`Unregistered: ${id} (will not restart on next gateway start)`);
}

function cleanCommand() {
  cleanRegistry();
  console.log('Cleaned stale entries from registry');
}

function reportCommand(rawArgs: string[]) {
  const scriptPath = path.join(__dirname, 'report.ts');
  const result = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--no-warnings', '--import', 'tsx', scriptPath, ...rawArgs],
    {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env },
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
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

  // Parse --set flags before stripping them
  const initialState = parseSetFlags(restArgs);
  const cleanedArgs = stripSetFlags(restArgs);

  // Extract positional args (non-flag args)
  const positional: string[] = [];
  const flagArgs: string[] = [];
  for (let i = 0; i < cleanedArgs.length; i++) {
    if (cleanedArgs[i].startsWith('--')) {
      flagArgs.push(cleanedArgs[i]);
      // If next arg doesn't start with --, it's a flag value
      if (i + 1 < cleanedArgs.length && !cleanedArgs[i + 1].startsWith('--')) {
        flagArgs.push(cleanedArgs[i + 1]);
        i++;
      }
    } else {
      positional.push(cleanedArgs[i]);
    }
  }

  const args = parseArgs(flagArgs);

  switch (subcommand) {
    case 'run':
      await runCommand(args, positional, initialState);
      break;
    case 'stop':
      stopCommand(positional);
      break;
    case 'list':
      listCommand();
      break;
    case 'examples':
      await examplesCommand();
      break;
    case 'status':
      statusCommand();
      break;
    case 'clean':
      cleanCommand();
      break;
    case 'report':
      reportCommand(restArgs);
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
