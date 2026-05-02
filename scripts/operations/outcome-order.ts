#!/usr/bin/env npx tsx
// Execute a HIP-4 outcome order on Hyperliquid

import { getClient } from '../core/client.js';
import { checkBuilderFeeApproval, formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - HIP-4 Outcome Order
=================================

Buy or sell a YES/NO outcome token.

Usage:
  openbroker outcome-order --outcome <id|#encoding|+encoding> --outcome-side <yes|no> --side <buy|sell> --size <SIZE>

Options:
  --outcome        Outcome id, outcome spot coin (#1230), or token name (+1230)
  --outcome-side   Outcome side when --outcome is a plain id: yes/no or 0/1 (default: yes)
  --side           Trade side: buy or sell
  --size           Order size in outcome token units
  --price          Limit price between 0.001 and 0.999 (omit for market IOC)
  --tif            Time-in-force for limit orders: Gtc, Ioc, Alo (default: Gtc)
  --slippage       Slippage tolerance in bps for market orders (default: config, usually 50)
  --sz-decimals    Override size decimals if outcome metadata omits token decimals
  --dry            Dry run - show order details without executing
  --verbose        Show full API request/response for debugging

Examples:
  openbroker outcomes --query BTC
  openbroker outcome-order --outcome 123 --outcome-side yes --side buy --size 10 --dry
  openbroker outcome-buy --outcome 123 --outcome-side no --size 5 --price 0.42
  openbroker outcome-sell --outcome #1230 --size 10
`);
}

function formatOutcomePrice(price: number): string {
  return price.toFixed(4);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const outcomeRef = args.outcome as string;
  const outcomeSide = args['outcome-side'] as string | undefined;
  const side = args.side as string;
  const size = parseFloat(args.size as string);
  const price = args.price ? parseFloat(args.price as string) : undefined;
  const tif = (args.tif as 'Gtc' | 'Ioc' | 'Alo') ?? 'Gtc';
  const slippage = args.slippage ? parseInt(args.slippage as string) : undefined;
  const szDecimals = args['sz-decimals'] ? parseInt(args['sz-decimals'] as string, 10) : undefined;
  const dryRun = args.dry as boolean;

  if (!outcomeRef || !side || isNaN(size)) {
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

  if (price !== undefined && (price <= 0 || price >= 1)) {
    console.error('Error: --price must be between 0 and 1 for outcome tokens');
    process.exit(1);
  }

  if (szDecimals !== undefined && (szDecimals < 0 || szDecimals > 8)) {
    console.error('Error: --sz-decimals must be between 0 and 8');
    process.exit(1);
  }

  const client = getClient();
  if (args.verbose) client.verbose = true;

  const isBuy = side === 'buy';
  const isMarket = price === undefined;

  console.log('Open Broker - HIP-4 Outcome Order');
  console.log('=================================\n');

  await checkBuilderFeeApproval(client);

  try {
    const resolved = client.resolveOutcomeRef(outcomeRef, outcomeSide);
    const market = await client.getOutcomeMarket(resolved.outcome);
    const marketSide = market?.sides.find((s) => s.side === resolved.side);
    const sideName = marketSide?.name ?? (resolved.side === 0 ? 'Yes' : 'No');
    const midPrice = await client.getOutcomeMidPrice(resolved.outcome, resolved.side);
    const slippageBps = slippage ?? 50;
    const limitPrice = isMarket
      ? (isBuy ? midPrice * (1 + slippageBps / 10000) : midPrice * (1 - slippageBps / 10000))
      : price;
    const notional = midPrice * size;

    console.log('Order Details');
    console.log('-------------');
    console.log(`Outcome:      ${resolved.outcome}`);
    console.log(`Market:       ${market?.name ?? 'Unknown'}${market?.parsedDescription.underlying ? ` (${market.parsedDescription.underlying})` : ''}`);
    if (market?.parsedDescription.expiry) console.log(`Expiry:       ${market.parsedDescription.expiry}`);
    if (market?.parsedDescription.targetPrice) console.log(`Target:       ${market.parsedDescription.targetPrice}`);
    console.log(`Outcome Side: ${sideName.toUpperCase()} (${resolved.side})`);
    console.log(`Coin:         ${resolved.coin}`);
    console.log(`Asset ID:     ${resolved.assetId}`);
    console.log(`Trade Side:   ${isBuy ? 'BUY' : 'SELL'}`);
    console.log(`Size:         ${size}`);
    console.log(`Mid Price:    ${formatOutcomePrice(midPrice)}`);
    if (isMarket) {
      console.log(`Type:         Market (IOC)`);
      console.log(`Limit Price:  ${formatOutcomePrice(limitPrice)} (${slippageBps} bps slippage)`);
    } else {
      console.log(`Type:         Limit (${tif})`);
      console.log(`Limit Price:  ${formatOutcomePrice(price)}`);
    }
    console.log(`Notional:     ~${formatUsd(notional)}`);
    if (marketSide?.szDecimals !== undefined || szDecimals !== undefined) {
      console.log(`Sz Decimals:  ${szDecimals ?? marketSide?.szDecimals}`);
    }
    console.log(`Builder Fee:  ${client.builderInfo.f / 10} bps`);

    if (dryRun) {
      console.log('\nDry run - order not submitted');
      return;
    }

    console.log('\nExecuting...');

    const response = isMarket
      ? await client.outcomeMarketOrder(outcomeRef, outcomeSide, isBuy, size, slippage, szDecimals)
      : await client.outcomeLimitOrder(outcomeRef, outcomeSide, isBuy, size, price!, tif, szDecimals);

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
          console.log('Filled');
          console.log(`   Order ID:  ${status.filled.oid}`);
          console.log(`   Size:      ${fillSz}`);
          console.log(`   Avg Price: ${formatOutcomePrice(avgPx)}`);
          console.log(`   Notional:  ${formatUsd(fillSz * avgPx)}`);
        } else if (status.resting) {
          console.log('Resting');
          console.log(`   Order ID:  ${status.resting.oid}`);
        } else if (status.error) {
          console.log(`Error: ${status.error}`);
        } else {
          console.log('Unknown status:');
          console.log(JSON.stringify(status, null, 2));
        }
      }
    } else if (response.status === 'err') {
      console.log(`API Error: ${response.response || JSON.stringify(response)}`);
    } else {
      console.log('Unexpected response:');
      console.log(JSON.stringify(response, null, 2));
    }
  } catch (error) {
    console.error('Error executing outcome order:', error);
    console.error('Note: Hyperliquid currently documents outcomeMeta as testnet-only.');
    process.exit(1);
  }
}

main();
