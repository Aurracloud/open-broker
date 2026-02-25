#!/usr/bin/env npx tsx
// View recent trades (tape) for an asset on Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker trades --coin <symbol> [options]

Options:
  --coin <symbol>   Asset symbol (required, e.g. ETH, BTC)
  --top <n>         Show last N trades (default: 30)
  --help, -h        Show this help

Examples:
  openbroker trades --coin ETH
  openbroker trades --coin BTC --top 50
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const coin = args.coin as string | undefined;
  if (!coin) {
    console.error('Error: --coin is required');
    printUsage();
    process.exit(1);
  }

  const top = parseInt(args.top as string) || 30;
  const client = getClient();

  console.log(`Open Broker - ${coin.toUpperCase()} Recent Trades`);
  console.log('='.repeat(40) + '\n');

  try {
    let trades = await client.getRecentTrades(coin.toUpperCase());

    // Most recent first
    trades.sort((a, b) => b.time - a.time);
    trades = trades.slice(0, top);

    if (trades.length === 0) {
      console.log('No recent trades found');
      return;
    }

    // Table header
    console.log(
      'Time'.padEnd(20) +
      'Side'.padEnd(6) +
      'Size'.padEnd(14) +
      'Price'
    );
    console.log('─'.repeat(55));

    let totalVol = 0;
    let buyVol = 0;
    let sellVol = 0;

    for (const trade of trades) {
      const time = new Date(trade.time).toLocaleString();
      const side = trade.side === 'B' ? 'BUY' : 'SELL';
      const notional = parseFloat(trade.px) * parseFloat(trade.sz);
      totalVol += notional;
      if (trade.side === 'B') buyVol += notional;
      else sellVol += notional;

      console.log(
        time.padEnd(20) +
        side.padEnd(6) +
        trade.sz.padEnd(14) +
        formatUsd(parseFloat(trade.px))
      );
    }

    // Summary
    console.log('─'.repeat(55));
    console.log(`Trades: ${trades.length}  |  Volume: ${formatUsd(totalVol)}`);
    const buyPct = totalVol > 0 ? (buyVol / totalVol * 100).toFixed(1) : '0';
    const sellPct = totalVol > 0 ? (sellVol / totalVol * 100).toFixed(1) : '0';
    console.log(`Buy: ${buyPct}%  |  Sell: ${sellPct}%`);
  } catch (error) {
    console.error('Error fetching trades:', error);
    process.exit(1);
  }
}

main();
