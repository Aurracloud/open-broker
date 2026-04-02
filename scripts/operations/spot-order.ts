#!/usr/bin/env npx tsx
// Execute a spot order on Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs, checkBuilderFeeApproval } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - Spot Order
========================

Buy or sell spot tokens on Hyperliquid.

Usage:
  npx tsx scripts/operations/spot-order.ts --coin <COIN> --side <buy|sell> --size <SIZE>

Options:
  --coin      Base token to trade (e.g., PURR, HYPE)
  --side      Order side: buy or sell
  --size      Order size in base token units
  --price     Limit price (omit for market order)
  --tif       Time-in-force for limit orders: Gtc, Ioc, Alo (default: Gtc)
  --slippage  Slippage tolerance in bps for market orders (default: from config, usually 50 = 0.5%)
  --dry       Dry run - show order details without executing
  --verbose   Show full API request/response for debugging

Environment:
  HYPERLIQUID_PRIVATE_KEY  Your wallet private key (0x...)
  HYPERLIQUID_NETWORK      "mainnet" or "testnet" (default: mainnet)

Examples:
  npx tsx scripts/operations/spot-order.ts --coin PURR --side buy --size 1000
  npx tsx scripts/operations/spot-order.ts --coin HYPE --side sell --size 50 --price 25.50
  npx tsx scripts/operations/spot-order.ts --coin PURR --side buy --size 500 --dry
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const coin = args.coin as string;
  const side = args.side as string;
  const size = parseFloat(args.size as string);
  const price = args.price ? parseFloat(args.price as string) : undefined;
  const tif = (args.tif as 'Gtc' | 'Ioc' | 'Alo') ?? 'Gtc';
  const slippage = args.slippage ? parseInt(args.slippage as string) : undefined;
  const dryRun = args.dry as boolean;

  if (!coin || !side || isNaN(size)) {
    printUsage();
    process.exit(1);
  }

  if (side !== 'buy' && side !== 'sell') {
    console.error('Error: --side must be "buy" or "sell"');
    process.exit(1);
  }

  if (size <= 0) {
    console.error('Error: --size must be positive');
    process.exit(1);
  }

  const isBuy = side === 'buy';
  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  console.log('Open Broker - Spot Order');
  console.log('========================\n');

  await checkBuilderFeeApproval(client);

  try {
    // Load spot metadata to get the pair index, then use allMids for accurate price
    const spotMeta = await client.getSpotMeta();
    const tokenMap = new Map<number, string>();
    for (const t of spotMeta.tokens) tokenMap.set(t.index, t.name);

    // Find the USDC-quoted pair for this coin (prefer quote token 0 = USDC)
    let pairName = '';
    let spotCoinKey = '';
    for (const pair of spotMeta.universe) {
      const baseName = tokenMap.get(pair.tokens[0]) ?? '';
      if (baseName.toUpperCase() !== coin.toUpperCase()) continue;
      const quoteName = tokenMap.get(pair.tokens[1]) ?? 'USDC';
      // Prefer USDC pair; if already found a USDC pair, skip non-USDC pairs
      if (pairName && pair.tokens[1] !== 0) continue;
      pairName = `${baseName}/${quoteName}`;
      spotCoinKey = pair.name; // "@107" or "PURR/USDC"
      if (pair.tokens[1] === 0) break; // USDC pair found, stop
    }

    if (!spotCoinKey) {
      console.error(`Error: No spot market found for ${coin}`);
      console.error('Use "openbroker spot" to see available spot markets.');
      process.exit(1);
    }

    // Use allMids for live price (spotMetaAndAssetCtxs contexts can be misaligned)
    const mids = await client.getAllMids();
    const midPrice = parseFloat(mids[spotCoinKey] || '0');

    if (!midPrice || midPrice === 0) {
      console.error(`Error: No spot price for ${coin} (${spotCoinKey})`);
      process.exit(1);
    }

    const isMarket = price === undefined;
    const slippageBps = slippage ?? 50;
    const displayPrice = isMarket
      ? (isBuy ? midPrice * (1 + slippageBps / 10000) : midPrice * (1 - slippageBps / 10000))
      : price;
    const notional = midPrice * size;

    console.log('Order Details');
    console.log('-------------');
    console.log(`Pair:         ${pairName}`);
    console.log(`Side:         ${isBuy ? 'BUY' : 'SELL'}`);
    console.log(`Size:         ${size} ${coin}`);
    console.log(`Mid Price:    ${formatUsd(midPrice)}`);
    if (isMarket) {
      console.log(`Type:         Market (IOC)`);
      console.log(`Limit Price:  ${formatUsd(displayPrice)} (${slippageBps} bps slippage)`);
    } else {
      console.log(`Type:         Limit (${tif})`);
      console.log(`Limit Price:  ${formatUsd(price)}`);
    }
    console.log(`Notional:     ~${formatUsd(notional)}`);
    console.log(`Builder Fee:  ${client.builderInfo.f / 10} bps`);

    if (dryRun) {
      console.log('\n🔍 Dry run - order not submitted');
      return;
    }

    console.log('\nExecuting...');

    const response = isMarket
      ? await client.spotMarketOrder(coin, isBuy, size, slippage)
      : await client.spotLimitOrder(coin, isBuy, size, price!, tif);

    console.log('\nResult');
    console.log('------');

    if (args.verbose || process.env.VERBOSE) {
      console.log('\nFull Response:');
      console.log(JSON.stringify(response, null, 2));
    }

    if (response.status === 'ok' && response.response && typeof response.response === 'object') {
      const statuses = response.response.data.statuses;
      for (const status of statuses) {
        if (status.filled) {
          const fillSz = parseFloat(status.filled.totalSz);
          const avgPx = parseFloat(status.filled.avgPx);
          const fillNotional = fillSz * avgPx;

          console.log(`✅ Filled`);
          console.log(`   Order ID:  ${status.filled.oid}`);
          console.log(`   Size:      ${fillSz} ${coin}`);
          console.log(`   Avg Price: ${formatUsd(avgPx)}`);
          console.log(`   Notional:  ${formatUsd(fillNotional)}`);
        } else if (status.resting) {
          console.log(`⏳ Resting`);
          console.log(`   Order ID:  ${status.resting.oid}`);
        } else if (status.error) {
          console.log(`❌ Error: ${status.error}`);
        } else {
          console.log(`⚠️  Unknown status:`);
          console.log(JSON.stringify(status, null, 2));
        }
      }
    } else if (response.status === 'err') {
      console.log(`❌ API Error: ${response.response || JSON.stringify(response)}`);
    } else {
      console.log(`❌ Unexpected response:`);
      console.log(JSON.stringify(response, null, 2));
    }

  } catch (error) {
    console.error('Error executing spot order:', error);
    process.exit(1);
  }
}

main();
