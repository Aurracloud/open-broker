#!/usr/bin/env npx tsx
// View TWAP order history and status

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - TWAP Status
==========================

View your TWAP order history and currently running TWAP orders.

Usage:
  npx tsx scripts/operations/twap-status.ts [--active]

Options:
  --active      Show only active (running) TWAP orders
  --verbose     Show debug output

Examples:
  npx tsx scripts/operations/twap-status.ts            # All TWAP history
  npx tsx scripts/operations/twap-status.ts --active    # Only running TWAPs
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const activeOnly = args.active as boolean;
  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  console.log('Open Broker - TWAP Status');
  console.log('=========================\n');

  try {
    const history = await client.twapHistory();

    if (history.length === 0) {
      console.log('No TWAP orders found.');
      return;
    }

    const filtered = activeOnly
      ? history.filter(h => h.status.status === 'activated')
      : history;

    if (filtered.length === 0) {
      console.log(activeOnly ? 'No active TWAP orders.' : 'No TWAP orders found.');
      return;
    }

    console.log(`Found ${filtered.length} TWAP order${filtered.length > 1 ? 's' : ''}${activeOnly ? ' (active)' : ''}:\n`);

    for (const entry of filtered) {
      const { state, status, twapId } = entry;
      const isBuy = state.side === 'B';
      const executedSz = parseFloat(state.executedSz);
      const totalSz = parseFloat(state.sz);
      const executedNtl = parseFloat(state.executedNtl);
      const avgPrice = executedSz > 0 ? executedNtl / executedSz : 0;
      const pctDone = totalSz > 0 ? (executedSz / totalSz) * 100 : 0;

      const statusLabel = status.status === 'activated' ? 'RUNNING'
        : status.status === 'finished' ? 'FINISHED'
        : status.status === 'terminated' ? 'CANCELLED'
        : status.status === 'error' ? `ERROR: ${'description' in status ? status.description : ''}`
        : status.status;

      console.log(`  ${twapId !== undefined ? `TWAP #${twapId}` : 'TWAP'} — ${state.coin} ${isBuy ? 'BUY' : 'SELL'}`);
      console.log(`    Status:     ${statusLabel}`);
      console.log(`    Size:       ${executedSz} / ${totalSz} (${pctDone.toFixed(1)}%)`);
      if (avgPrice > 0) {
        console.log(`    Avg Price:  ${formatUsd(avgPrice)}`);
        console.log(`    Notional:   ${formatUsd(executedNtl)}`);
      }
      console.log(`    Duration:   ${state.minutes}m, Randomize: ${state.randomize ? 'yes' : 'no'}`);
      console.log(`    Started:    ${new Date(state.timestamp).toLocaleString()}`);
      console.log('');
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
