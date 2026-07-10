// CLI entry point for `openbroker guardian` — read-only position risk
// monitoring with Telegram / agent-hook delivery. The CLI counterpart of the
// hosted guardian at /markets/guardian.

import { parseArgs } from '../core/utils.js';
import { getClient } from '../core/client.js';
import { getConfigPath } from '../core/config.js';
import { startGuardian, type GuardianOptions } from './engine.js';
import {
  generateLinkCode,
  getTelegramBotInfo,
  loadTelegramSettings,
  saveEnvVar,
  sendTelegramMessage,
  waitForTelegramLink,
} from './telegram.js';
import {
  GUARDIAN_RULE_IDS,
  GUARDIAN_RULE_LABELS,
  type GuardianPrefs,
  type GuardianRuleId,
  type GuardianSeverity,
  type GuardianThresholds,
} from './types.js';

function printUsage() {
  console.log(`
OpenBroker Guardian — read-only position risk monitoring

Watches Hyperliquid addresses for liquidation risk, missing TP/SL, funding
bleed and more. Never touches your keys or places orders. Alerts go to the
console and (once connected) Telegram; if an OpenClaw agent gateway is
configured, alerts also wake the agent.

Usage:
  openbroker guardian run [options]         Start watching (long-running)
  openbroker guardian connect               Link a Telegram chat for alerts
  openbroker guardian test                  Send a test Telegram message
  openbroker guardian status                Show guardian configuration
  openbroker guardian rules                 List alert rules

Options (for run):
  --address <0x..[,0x..]>   Address(es) to watch (default: configured account)
  --min-severity <level>    info | warning | critical (default: info)
  --disable <rules>         CSV of rules to turn off (see: guardian rules)
  --only <rules>            CSV of rules to run exclusively
  --poll <ms>               Position poll interval (default: 30000; 15000 near liquidation)
  --orders-poll <ms>        Open-orders poll interval (default: 120000)
  --liq-warn <pct>          Liq-distance warning threshold (default: 10)
  --liq-critical <pct>      Liq-distance critical threshold (default: 5)
  --margin-pct <pct>        Margin-usage warning threshold (default: 80)
  --funding-apr <pct>       Funding-bleed APR threshold (default: 15)
  --tpsl-minutes <min>      Minutes unprotected before no-TP/SL alert (default: 15)
  --stale-hours <h>         Hours resting before stale-order alert (default: 12)
  --no-telegram             Don't deliver to Telegram even if linked
  --no-ws                   Disable the WebSocket liquidation fast lane
  --json                    Print alerts as JSON lines (agent-friendly)
  --verbose                 Show debug output

Telegram setup (one-time):
  1. Message @BotFather on Telegram, send /newbot, and copy the bot token
  2. Put it in your config:  TELEGRAM_BOT_TOKEN=123456:ABC-...
  3. Run: openbroker guardian connect   (then tap the printed link)

Examples:
  openbroker guardian run
  openbroker guardian run --address 0xabc...,0xdef... --min-severity warning
  openbroker guardian run --disable position_lifecycle,stale_order
  openbroker guardian run --json --no-telegram
`);
}

const SEVERITIES: GuardianSeverity[] = ['info', 'warning', 'critical'];

function parseRuleCsv(raw: string, flag: string): GuardianRuleId[] {
  const rules = raw.split(',').map((r) => r.trim()).filter(Boolean);
  for (const rule of rules) {
    if (!GUARDIAN_RULE_IDS.includes(rule as GuardianRuleId)) {
      console.error(`Error: unknown rule '${rule}' in ${flag}. Valid rules: ${GUARDIAN_RULE_IDS.join(', ')}`);
      process.exit(1);
    }
  }
  return rules as GuardianRuleId[];
}

function parseNum(args: Record<string, string | boolean>, key: string): number | undefined {
  const raw = args[key];
  if (raw === undefined || raw === true) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Error: --${key} must be a positive number`);
    process.exit(1);
  }
  return n;
}

async function runCommand(args: Record<string, string | boolean>) {
  const addresses = typeof args.address === 'string'
    ? args.address.split(',').map((a) => a.trim()).filter(Boolean)
    : undefined;

  const prefs: GuardianPrefs = {};
  if (typeof args['min-severity'] === 'string') {
    const sev = args['min-severity'] as GuardianSeverity;
    if (!SEVERITIES.includes(sev)) {
      console.error(`Error: --min-severity must be one of: ${SEVERITIES.join(', ')}`);
      process.exit(1);
    }
    prefs.minSeverity = sev;
  }
  if (typeof args.disable === 'string') {
    prefs.rules = Object.fromEntries(parseRuleCsv(args.disable, '--disable').map((r) => [r, false]));
  }
  if (typeof args.only === 'string') {
    const only = new Set(parseRuleCsv(args.only, '--only'));
    prefs.rules = Object.fromEntries(GUARDIAN_RULE_IDS.map((r) => [r, only.has(r)]));
  }

  const thresholds: Partial<GuardianThresholds> = {};
  const liqWarn = parseNum(args, 'liq-warn');
  const liqCritical = parseNum(args, 'liq-critical');
  if (liqWarn !== undefined || liqCritical !== undefined) {
    const warn = (liqWarn ?? 10) / 100;
    const crit = (liqCritical ?? 5) / 100;
    thresholds.liqThresholds = [
      { pct: warn, severity: 'warning' },
      { pct: crit, severity: 'critical' },
      { pct: crit / 2.5, severity: 'critical' },
    ];
  }
  const marginPct = parseNum(args, 'margin-pct');
  if (marginPct !== undefined) {
    thresholds.marginThresholdPct = marginPct;
    thresholds.marginRearmPct = marginPct * 0.9;
  }
  const fundingApr = parseNum(args, 'funding-apr');
  if (fundingApr !== undefined) thresholds.fundingBleedAprPct = fundingApr;
  const tpslMinutes = parseNum(args, 'tpsl-minutes');
  if (tpslMinutes !== undefined) thresholds.noTpslAfterMs = tpslMinutes * 60_000;
  const staleHours = parseNum(args, 'stale-hours');
  if (staleHours !== undefined) thresholds.staleOrderAgeMs = staleHours * 3600_000;

  const options: GuardianOptions = {
    addresses,
    prefs,
    thresholds,
    pollIntervalMs: parseNum(args, 'poll'),
    ordersIntervalMs: parseNum(args, 'orders-poll'),
    useWebSocket: args['no-ws'] !== true,
    telegram: args['no-telegram'] === true ? false : undefined,
    json: args.json === true,
    verbose: args.verbose === true,
  };

  const guardian = await startGuardian(options);

  const stats = guardian.getStats();
  const disabled = GUARDIAN_RULE_IDS.filter((r) => prefs.rules?.[r] === false);
  if (!options.json) {
    console.log('OpenBroker Guardian — watching (read-only, Ctrl+C to stop)');
    console.log(`  Addresses:    ${stats.addresses.join(', ')}`);
    console.log(`  Min severity: ${prefs.minSeverity ?? 'info'}`);
    console.log(`  Rules off:    ${disabled.length > 0 ? disabled.join(', ') : 'none'}`);
    console.log(`  Channels:     ${stats.channels.join(', ')}`);
    if (!stats.channels.includes('telegram')) {
      console.log('  Tip: run `openbroker guardian connect` to get alerts in Telegram.');
    }
    console.log('');
    for (const target of guardian.getTargets()) {
      const positions = [...target.positions.values()];
      if (positions.length === 0) {
        console.log(`  ${target.address}: no open positions`);
        continue;
      }
      console.log(`  ${target.address}: equity $${target.equity.toFixed(2)}, margin ${target.marginUsedPct.toFixed(1)}%`);
      for (const pos of positions) {
        const liq = pos.liquidationPx !== null ? `liq $${pos.liquidationPx}` : 'no liq px';
        console.log(`    ${pos.side} ${Math.abs(pos.szi)} ${pos.coin} @ $${pos.entryPx ?? '?'} (${pos.leverage}x, ${liq}, uPnL $${pos.unrealizedPnl.toFixed(2)})`);
      }
    }
    console.log('');
  }

  const shutdown = async () => {
    if (!options.json) console.log('\nStopping guardian...');
    await guardian.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise(() => {});
}

async function connectCommand(args: Record<string, string | boolean>) {
  const settings = loadTelegramSettings();
  const token = typeof args.token === 'string' ? args.token : settings.token;

  if (!token) {
    console.log('No Telegram bot token configured.\n');
    console.log('One-time setup:');
    console.log('  1. Open Telegram and message @BotFather');
    console.log('  2. Send /newbot and follow the prompts (any name, e.g. "my-guardian-bot")');
    console.log('  3. Copy the bot token BotFather gives you');
    console.log(`  4. Add it to your config (${getConfigPath()}):`);
    console.log('       TELEGRAM_BOT_TOKEN=123456789:AAF...');
    console.log('  5. Re-run: openbroker guardian connect');
    process.exit(1);
  }

  let bot: { username: string };
  try {
    bot = await getTelegramBotInfo(token);
  } catch (err) {
    console.error(`Could not reach the Telegram bot: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Check TELEGRAM_BOT_TOKEN.');
    process.exit(1);
  }

  const code = generateLinkCode();
  console.log(`Bot: @${bot!.username}`);
  console.log('\nOpen this link in Telegram and tap START (or send the code to the bot):\n');
  console.log(`  https://t.me/${bot!.username}?start=${code}`);
  console.log(`\n  code: ${code}`);
  console.log('\nWaiting for the link (10 min timeout, Ctrl+C to abort)...');

  const chatId = await waitForTelegramLink(token, code);
  if (chatId === null) {
    console.error('\nTimed out waiting for the Telegram link. Re-run: openbroker guardian connect');
    process.exit(1);
  }

  const savedTo = saveEnvVar('TELEGRAM_CHAT_ID', String(chatId));
  if (typeof args.token === 'string') saveEnvVar('TELEGRAM_BOT_TOKEN', args.token);
  console.log(`\nLinked chat ${chatId} — saved TELEGRAM_CHAT_ID to ${savedTo}`);
  console.log('Guardian alerts will now be delivered to Telegram. Try: openbroker guardian test');
}

async function testCommand() {
  const { token, chatId } = loadTelegramSettings();
  if (!token || !chatId) {
    console.error('Telegram not connected. Run: openbroker guardian connect');
    process.exit(1);
  }
  await sendTelegramMessage(token, chatId, '<b>[TEST]</b> OpenBroker guardian is connected. Risk alerts will arrive here.');
  console.log('Test message sent.');
}

async function statusCommand() {
  const { token, chatId } = loadTelegramSettings();
  let address = 'not configured';
  try {
    address = getClient().address;
  } catch { /* read-only mode without an address */ }

  console.log('OpenBroker Guardian — status\n');
  console.log(`  Default address:  ${address}`);
  console.log(`  Config file:      ${getConfigPath()}`);
  console.log(`  Telegram token:   ${token ? 'set' : 'NOT SET (see: openbroker guardian connect)'}`);
  console.log(`  Telegram chat:    ${chatId ? `linked (${chatId})` : 'not linked'}`);
  console.log(`  Agent hook:       ${process.env.OPENCLAW_HOOKS_TOKEN ? 'configured' : 'not configured'}`);
  console.log('\nRules (all on by default):');
  for (const rule of GUARDIAN_RULE_IDS) {
    console.log(`  ${rule.padEnd(20)} ${GUARDIAN_RULE_LABELS[rule]}`);
  }
}

function rulesCommand() {
  console.log('Guardian alert rules:\n');
  const details: Record<GuardianRuleId, string> = {
    liq_proximity: 'warning at 10% from liquidation price, critical at 5% and 2% (--liq-warn/--liq-critical)',
    no_tpsl: 'info when a position is open 15+ min with no reduce-only trigger orders (--tpsl-minutes)',
    stale_order: 'info for limit orders resting 12h+ and 3%+ from mid (--stale-hours)',
    margin_usage: 'warning when margin used exceeds 80% of equity (--margin-pct)',
    funding_bleed: 'warning when paying 15%+ APR funding for 60+ min (--funding-apr)',
    position_lifecycle: 'info on position open / close / resize',
  };
  for (const rule of GUARDIAN_RULE_IDS) {
    console.log(`  ${rule.padEnd(20)} ${GUARDIAN_RULE_LABELS[rule]}`);
    console.log(`  ${''.padEnd(20)} ${details[rule]}\n`);
  }
  console.log('Disable rules with --disable <csv>, or run a subset with --only <csv>.');
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === '--help' || rawArgs[0] === '-h') {
    printUsage();
    process.exit(0);
  }

  const subcommand = rawArgs[0];
  const args = parseArgs(rawArgs.slice(1));

  switch (subcommand) {
    case 'run':
      await runCommand(args);
      break;
    case 'connect':
      await connectCommand(args);
      break;
    case 'test':
      await testCommand();
      break;
    case 'status':
      await statusCommand();
      break;
    case 'rules':
      rulesCommand();
      break;
    default:
      console.error(`Unknown subcommand: ${subcommand}`);
      console.log('Run "openbroker guardian --help" for usage');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
