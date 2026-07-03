#!/usr/bin/env npx tsx
// Set Take Profit and/or Stop Loss on an existing position

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs, parseOrderStatus } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - Set TP/SL
=======================

Add take profit and/or stop loss orders to an existing position.
Placed as one batch with Hyperliquid's positionTpsl grouping: the triggers
track the open position and OCO-cancel each other when one fires.

Usage:
  npx tsx scripts/operations/set-tpsl.ts --coin <COIN> [--tp <PRICE>] [--sl <PRICE>]

Options:
  --coin        Asset with open position (e.g., ETH, BTC, HYPE)
  --tp          Take profit trigger price
  --sl          Stop loss trigger price
  --size        Size to protect (default: full position size)
  --sl-slippage Stop loss fill cap past the trigger in bps (default: 100 = 1%)
  --sl-limit    Place the SL as a stop-limit instead of a market trigger.
                Warning: a gap move past the limit band can skip the stop
                entirely and leave the position unprotected.
  --dry         Dry run - show orders without placing
  --verbose     Show debug output

Price Formats:
  --tp 40       Absolute price ($40)
  --tp +10%     Percentage above entry price
  --sl -5%      Percentage below entry price (for longs)
  --sl entry    Stop loss at entry price (breakeven)

Examples:
  # Set TP at $40 and SL at $30 on HYPE long
  npx tsx scripts/operations/set-tpsl.ts --coin HYPE --tp 40 --sl 30

  # Set TP at +10% from entry, SL at entry (breakeven)
  npx tsx scripts/operations/set-tpsl.ts --coin HYPE --tp +10% --sl entry

  # Set only stop loss at -5% from entry
  npx tsx scripts/operations/set-tpsl.ts --coin ETH --sl -5%

  # Set TP/SL on partial position
  npx tsx scripts/operations/set-tpsl.ts --coin ETH --tp 4000 --sl 3500 --size 0.5

How Trigger Orders Work:
  - TP/SL are trigger orders, NOT regular limit orders
  - They sit dormant until price reaches the trigger level
  - TP executes as a limit order at the target; SL executes as a market
    order capped by the slippage band (use --sl-limit for a stop-limit)
  - These are reduce-only orders (close position, don't reverse)
  - positionTpsl grouping ties them to the position: when one fires and
    closes the position, the venue cancels the other automatically
`);
}

function parsePrice(input: string, entryPrice: number, isLong: boolean): number | null {
  if (!input) return null;

  // Handle "entry" keyword for breakeven
  if (input.toLowerCase() === 'entry') {
    return entryPrice;
  }

  // Handle percentage format: +10%, -5%
  const pctMatch = input.match(/^([+-]?)(\d+(?:\.\d+)?)%$/);
  if (pctMatch) {
    const sign = pctMatch[1] || '+';
    const pct = parseFloat(pctMatch[2]) / 100;

    if (sign === '+') {
      return entryPrice * (1 + pct);
    } else {
      return entryPrice * (1 - pct);
    }
  }

  // Handle absolute price
  const price = parseFloat(input);
  if (!isNaN(price) && price > 0) {
    return price;
  }

  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  const coin = args.coin as string;
  const tpInput = args.tp as string | undefined;
  const slInput = args.sl as string | undefined;
  const sizeOverride = args.size ? parseFloat(args.size as string) : undefined;
  const slSlippage = args['sl-slippage'] ? parseInt(args['sl-slippage'] as string) : 100;
  const slMarket = !(args['sl-limit'] as boolean);
  const dryRun = args.dry as boolean;

  if (!coin) {
    printUsage();
    process.exit(1);
  }

  if (!tpInput && !slInput) {
    console.error('Error: Must specify at least --tp or --sl');
    process.exit(1);
  }

  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  console.log('Open Broker - Set TP/SL');
  console.log('=======================\n');

  try {
    // Get current position
    const userState = await client.getUserState();
    const position = userState.assetPositions.find(p => p.position.coin === coin);

    if (!position) {
      console.error(`Error: No open position for ${coin}`);
      console.log('\nYour positions:');
      for (const pos of userState.assetPositions) {
        const size = parseFloat(pos.position.szi);
        if (Math.abs(size) > 0) {
          console.log(`  ${pos.position.coin}: ${size > 0 ? 'LONG' : 'SHORT'} ${Math.abs(size)}`);
        }
      }
      process.exit(1);
    }

    const posSize = parseFloat(position.position.szi);
    const entryPrice = parseFloat(position.position.entryPx);
    const isLong = posSize > 0;
    const absSize = Math.abs(posSize);
    const size = sizeOverride ?? absSize;

    // Get current price
    const mids = await client.getAllMids();
    const currentPrice = parseFloat(mids[coin]);

    // Parse TP and SL prices
    const tpPrice = tpInput ? parsePrice(tpInput, entryPrice, isLong) : null;
    const slPrice = slInput ? parsePrice(slInput, entryPrice, isLong) : null;

    if (tpInput && tpPrice === null) {
      console.error(`Error: Invalid TP price format: ${tpInput}`);
      console.log('Use absolute price (e.g., 40), percentage (e.g., +10%), or "entry"');
      process.exit(1);
    }

    if (slInput && slPrice === null) {
      console.error(`Error: Invalid SL price format: ${slInput}`);
      console.log('Use absolute price (e.g., 35), percentage (e.g., -5%), or "entry"');
      process.exit(1);
    }

    // Triggers must sit on the correct side of the LIVE price, or the
    // exchange fires them immediately on placement.
    const directionErrors: string[] = [];
    if (isLong) {
      if (tpPrice && tpPrice <= currentPrice) {
        directionErrors.push(`TP (${formatUsd(tpPrice)}) must be above the current price (${formatUsd(currentPrice)}) for a LONG`);
      }
      if (slPrice && slPrice >= currentPrice) {
        directionErrors.push(`SL (${formatUsd(slPrice)}) must be below the current price (${formatUsd(currentPrice)}) for a LONG`);
      }
    } else {
      if (tpPrice && tpPrice >= currentPrice) {
        directionErrors.push(`TP (${formatUsd(tpPrice)}) must be below the current price (${formatUsd(currentPrice)}) for a SHORT`);
      }
      if (slPrice && slPrice <= currentPrice) {
        directionErrors.push(`SL (${formatUsd(slPrice)}) must be above the current price (${formatUsd(currentPrice)}) for a SHORT`);
      }
    }
    if (directionErrors.length > 0) {
      for (const err of directionErrors) console.error(`Error: ${err}`);
      console.error('A trigger on the wrong side of the live price fires immediately on placement.');
      process.exit(1);
    }

    // Calculate risk/reward
    let tpDistance = 0, slDistance = 0, riskReward = 0;
    if (tpPrice) {
      tpDistance = isLong
        ? (tpPrice - entryPrice) / entryPrice * 100
        : (entryPrice - tpPrice) / entryPrice * 100;
    }
    if (slPrice) {
      slDistance = isLong
        ? (entryPrice - slPrice) / entryPrice * 100
        : (slPrice - entryPrice) / entryPrice * 100;
    }
    if (tpDistance > 0 && slDistance > 0) {
      riskReward = tpDistance / slDistance;
    }

    console.log('Current Position');
    console.log('----------------');
    console.log(`Coin:          ${coin}`);
    console.log(`Direction:     ${isLong ? 'LONG' : 'SHORT'}`);
    console.log(`Size:          ${absSize}`);
    console.log(`Entry Price:   ${formatUsd(entryPrice)}`);
    console.log(`Current Price: ${formatUsd(currentPrice)}`);
    console.log(`Unrealized:    ${formatUsd(parseFloat(position.position.unrealizedPnl))}`);

    console.log('\nOrders to Place');
    console.log('---------------');
    if (tpPrice) {
      const tpSide = isLong ? 'SELL' : 'BUY';
      console.log(`Take Profit:   ${tpSide} ${size} @ ${formatUsd(tpPrice)} (+${tpDistance.toFixed(2)}% from entry)`);
    }
    if (slPrice) {
      const slSide = isLong ? 'SELL' : 'BUY';
      const slLimitPrice = isLong
        ? slPrice * (1 - slSlippage / 10000)
        : slPrice * (1 + slSlippage / 10000);
      console.log(`Stop Loss:     ${slSide} ${size} @ ${formatUsd(slPrice)} trigger, ${slMarket ? `market (fill capped at ${formatUsd(slLimitPrice)})` : `${formatUsd(slLimitPrice)} limit`} (-${slDistance.toFixed(2)}%)`);
    }
    if (riskReward > 0) {
      console.log(`Risk/Reward:   1:${riskReward.toFixed(2)}`);
    }

    // Potential outcomes
    const potentialProfit = tpPrice ? Math.abs(tpPrice - entryPrice) * size : 0;
    const potentialLoss = slPrice ? Math.abs(entryPrice - slPrice) * size : 0;
    console.log('\nPotential Outcomes');
    console.log('------------------');
    if (tpPrice) console.log(`If TP hits:    +${formatUsd(potentialProfit)}`);
    if (slPrice) console.log(`If SL hits:    -${formatUsd(potentialLoss)}`);

    if (dryRun) {
      console.log('\n🔍 Dry run - orders not placed');
      return;
    }

    console.log('\nPlacing trigger orders (positionTpsl batch)...\n');

    // One batch with positionTpsl grouping: the venue ties the triggers to
    // the open position and OCO-cancels the survivor when one fires.
    const exitSide = !isLong; // Opposite of position direction
    const response = await client.tpslOrders(coin, exitSide, size, {
      takeProfitPrice: tpPrice ?? undefined,
      stopLossPrice: slPrice ?? undefined,
      stopLossSlippageBps: slSlippage,
      stopLossIsMarket: slMarket,
      grouping: 'positionTpsl',
    });

    let tpOid: number | null = null;
    let slOid: number | null = null;
    let placementErrors = 0;
    if (response.status === 'ok' && response.response && typeof response.response === 'object') {
      const statuses = response.response.data.statuses.map(parseOrderStatus);
      let idx = 0;
      for (const leg of [tpPrice ? 'Take Profit' : null, slPrice ? 'Stop Loss' : null]) {
        if (!leg) continue;
        const status = statuses[idx++];
        const price = leg === 'Take Profit' ? tpPrice! : slPrice!;
        if (status?.kind === 'resting') {
          if (leg === 'Take Profit') tpOid = status.oid; else slOid = status.oid;
          console.log(`✅ ${leg} placed @ ${formatUsd(price)} (OID: ${status.oid})`);
        } else if (status?.kind === 'waiting') {
          console.log(`✅ ${leg} armed @ ${formatUsd(price)} (${status.state})`);
        } else if (status?.kind === 'error') {
          placementErrors++;
          console.log(`❌ ${leg} failed: ${status.error}`);
        } else {
          placementErrors++;
          console.log(`⚠️  ${leg} status:`, JSON.stringify(status));
        }
      }
    } else {
      placementErrors++;
      console.log(`❌ TP/SL failed: ${typeof response.response === 'string' ? response.response : 'Unknown error'}`);
    }

    // Summary
    console.log('\n========== Summary ==========');
    console.log(`Position:    ${isLong ? 'LONG' : 'SHORT'} ${absSize} ${coin}`);
    console.log(`Entry:       ${formatUsd(entryPrice)}`);
    if (tpOid) console.log(`Take Profit: ${formatUsd(tpPrice!)} (OID: ${tpOid})`);
    if (slOid) console.log(`Stop Loss:   ${formatUsd(slPrice!)} (OID: ${slOid}, ${slMarket ? 'market trigger' : 'stop-limit'})`);

    if (placementErrors === 0 && tpPrice && slPrice) {
      console.log(`\n💡 The triggers track the position: when one fires, the venue cancels the other.`);
    }
    if (placementErrors > 0) process.exit(1);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
