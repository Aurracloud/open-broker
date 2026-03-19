#!/usr/bin/env npx tsx
// TWAP (Time-Weighted Average Price) execution using Hyperliquid's native TWAP orders

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - TWAP Order (Native)
==================================

Place a native Hyperliquid TWAP order. The exchange handles order slicing
and execution timing server-side.

Usage:
  npx tsx scripts/operations/twap.ts --coin <COIN> --side <buy|sell> --size <SIZE> --duration <MINUTES>

Options:
  --coin        Asset to trade (e.g., ETH, BTC)
  --side        Order side: buy or sell
  --size        Total order size in base asset
  --duration    Total execution time in minutes (5–1440, i.e. 5 min to 24 hours)
  --randomize   Enable random order timing (default: true)
  --reduce-only Reduce-only order (default: false)
  --leverage    Set leverage (e.g., 10 for 10x)
  --dry         Dry run - show order plan without executing
  --verbose     Show debug output

Examples:
  # Execute 1 ETH buy over 30 minutes
  npx tsx scripts/operations/twap.ts --coin ETH --side buy --size 1 --duration 30

  # Execute 0.5 BTC sell over 2 hours without randomized timing
  npx tsx scripts/operations/twap.ts --coin BTC --side sell --size 0.5 --duration 120 --randomize false

  # Preview execution plan
  npx tsx scripts/operations/twap.ts --coin ETH --side buy --size 2 --duration 60 --dry
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const coin = args.coin as string;
  const side = args.side as string;
  const totalSize = parseFloat(args.size as string);
  const durationMinutes = parseInt(args.duration as string);
  const randomize = args.randomize === 'false' || args.randomize === false ? false : true;
  const reduceOnly = args['reduce-only'] as boolean || false;
  const leverage = args.leverage ? parseInt(args.leverage as string) : undefined;
  const dryRun = args.dry as boolean;

  if (!coin || !side || isNaN(totalSize) || isNaN(durationMinutes)) {
    printUsage();
    process.exit(1);
  }

  if (side !== 'buy' && side !== 'sell') {
    console.error('Error: --side must be "buy" or "sell"');
    process.exit(1);
  }

  if (totalSize <= 0) {
    console.error('Error: --size must be positive');
    process.exit(1);
  }

  if (durationMinutes < 5 || durationMinutes > 1440) {
    console.error('Error: --duration must be between 5 and 1440 minutes (5 min to 24 hours)');
    process.exit(1);
  }

  const isBuy = side === 'buy';
  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  console.log('Open Broker - Native TWAP Order');
  console.log('===============================\n');

  try {
    // Get current price for display
    const mids = await client.getAllMids();
    const midPrice = parseFloat(mids[coin]);
    if (!midPrice) {
      console.error(`Error: No market data for ${coin}`);
      process.exit(1);
    }

    const notional = midPrice * totalSize;

    console.log('Order Details');
    console.log('-------------');
    console.log(`Coin:           ${coin}`);
    console.log(`Side:           ${isBuy ? 'BUY' : 'SELL'}`);
    console.log(`Total Size:     ${totalSize}`);
    console.log(`Current Price:  ${formatUsd(midPrice)}`);
    console.log(`Est. Notional:  ${formatUsd(notional)}`);
    console.log(`Duration:       ${formatDuration(durationMinutes * 60)}`);
    console.log(`Randomize:      ${randomize ? 'yes' : 'no'}`);
    console.log(`Reduce Only:    ${reduceOnly ? 'yes' : 'no'}`);
    if (leverage) {
      console.log(`Leverage:       ${leverage}x`);
    }

    if (dryRun) {
      console.log('\nDry run - no order placed.');
      console.log('The exchange will handle order slicing and timing automatically.');
      return;
    }

    console.log('\nPlacing native TWAP order...\n');

    const response = await client.twapOrder(
      coin,
      isBuy,
      totalSize,
      durationMinutes,
      randomize,
      reduceOnly,
      leverage,
    );

    const status = response.response.data.status;
    if ('running' in status) {
      console.log(`TWAP order placed successfully!`);
      console.log(`TWAP ID: ${status.running.twapId}`);
      console.log(`\nThe exchange is now executing your TWAP order over ${formatDuration(durationMinutes * 60)}.`);
      console.log(`To cancel: openbroker twap-cancel --coin ${coin} --twap-id ${status.running.twapId}`);
      console.log(`To check status: openbroker twap-status`);
    } else if ('error' in status) {
      console.error(`TWAP order failed: ${status.error}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

main();
