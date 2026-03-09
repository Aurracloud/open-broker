#!/usr/bin/env npx tsx
// View trade fill history from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs, normalizeCoin } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker fills [options]

Options:
  --coin <symbol>   Filter by coin (e.g. ETH, BTC)
  --side <buy|sell>  Filter by side
  --top <n>         Show last N fills (default: 20)
  --help, -h        Show this help

Examples:
  openbroker fills
  openbroker fills --coin ETH
  openbroker fills --coin BTC --side buy --top 50
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const filterCoin = args.coin as string | undefined;
  const filterSide = args.side as string | undefined;
  const top = parseInt(args.top as string) || 20;
  const client = getClient();

  console.log('Open Broker - Trade Fills');
  console.log('========================\n');

  try {
    let fills = await client.getUserFills();

    if (filterCoin) {
      fills = fills.filter(f => f.coin === normalizeCoin(filterCoin));
    }
    if (filterSide) {
      const sideCode = filterSide.toLowerCase() === 'buy' ? 'B' : 'A';
      fills = fills.filter(f => f.side === sideCode);
    }

    // Most recent first
    fills.sort((a, b) => b.time - a.time);
    fills = fills.slice(0, top);

    if (fills.length === 0) {
      console.log('No fills found');
      return;
    }

    // Table header
    console.log(
      'Time'.padEnd(20) +
      'Coin'.padEnd(10) +
      'Side'.padEnd(6) +
      'Size'.padEnd(14) +
      'Price'.padEnd(14) +
      'Fee'.padEnd(12) +
      'Closed PnL'
    );
    console.log('─'.repeat(90));

    let totalFees = 0;
    let totalPnl = 0;

    for (const fill of fills) {
      const time = new Date(fill.time).toLocaleString();
      const side = fill.side === 'B' ? 'BUY' : 'SELL';
      const fee = parseFloat(fill.fee);
      const pnl = parseFloat(fill.closedPnl);
      totalFees += fee;
      totalPnl += pnl;

      console.log(
        time.padEnd(20) +
        fill.coin.padEnd(10) +
        side.padEnd(6) +
        fill.sz.padEnd(14) +
        formatUsd(parseFloat(fill.px)).padEnd(14) +
        formatUsd(fee).padEnd(12) +
        formatUsd(pnl)
      );
    }

    console.log('─'.repeat(90));
    console.log(`Showing ${fills.length} fills`);
    console.log(`Total Fees:       ${formatUsd(totalFees)}`);
    console.log(`Total Closed PnL: ${formatUsd(totalPnl)}`);
  } catch (error) {
    console.error('Error fetching fills:', error);
    process.exit(1);
  }
}

main();
