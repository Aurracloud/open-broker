#!/usr/bin/env npx tsx
// View API rate limit status on Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker rate-limit [options]

Options:
  --json        Output as JSON (machine-readable)
  --help, -h    Show this help

Examples:
  openbroker rate-limit
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const jsonOutput = args.json as boolean;
  const client = getClient();

  if (!jsonOutput) {
    console.log('Open Broker - API Rate Limit');
    console.log('===========================\n');
  }

  try {
    const rl = await client.getUserRateLimit();

    if (jsonOutput) {
      console.log(JSON.stringify(rl, null, 2));
      return;
    }

    const used = rl.nRequestsUsed;
    const cap = rl.nRequestsCap;
    const surplus = rl.nRequestsSurplus;
    const pct = cap > 0 ? (used / cap * 100) : 0;

    // Progress bar
    const barWidth = 30;
    const filled = Math.round(barWidth * Math.min(pct, 100) / 100);
    const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);

    console.log('Rate Limit Status');
    console.log('─'.repeat(40));
    console.log(`Requests Used:    ${used.toLocaleString()} / ${cap.toLocaleString()}`);
    console.log(`Usage:            [${bar}] ${pct.toFixed(1)}%`);
    console.log(`Surplus:          ${surplus.toLocaleString()}`);
    console.log(`Cum. Volume:      ${formatUsd(parseFloat(rl.cumVlm))}`);

    if (pct > 80) {
      console.log('\nWarning: API usage above 80% of capacity');
    }
  } catch (error) {
    console.error('Error fetching rate limit:', error);
    process.exit(1);
  }
}

main();
