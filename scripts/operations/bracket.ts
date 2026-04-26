#!/usr/bin/env npx tsx
// Bracket Order - Entry with Take Profit and Stop Loss

import { fileURLToPath } from 'url';
import { getClient } from '../core/client.js';
import { formatUsd, parseArgs, sleep } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - Bracket Order
===========================

Execute an entry order with automatic take-profit and stop-loss orders.
Creates a complete trade setup in one command.

Usage:
  npx tsx scripts/operations/bracket.ts --coin <COIN> --side <buy|sell> --size <SIZE> --tp <PCT> --sl <PCT>

Options:
  --coin        Asset to trade (e.g., ETH, BTC)
  --side        Entry side: buy (long) or sell (short)
  --size        Position size in base asset
  --entry       Entry type: market or limit (default: market)
  --price       Entry price (required if --entry limit)
  --tp          Take profit distance in % from entry
  --sl          Stop loss distance in % from entry
  --slippage    Slippage for market entry in bps (default: 50)
  --leverage    Set leverage (e.g., 10 for 10x). Cross for main perps, isolated for HIP-3
  --dry         Dry run - show bracket plan without executing

Take Profit / Stop Loss:
  For LONG (buy): TP is above entry, SL is below entry
  For SHORT (sell): TP is below entry, SL is above entry

Examples:
  # Long ETH with 3% take profit and 1.5% stop loss
  npx tsx scripts/operations/bracket.ts --coin ETH --side buy --size 0.5 --tp 3 --sl 1.5

  # Short BTC with limit entry at $100k, 5% TP, 2% SL
  npx tsx scripts/operations/bracket.ts --coin BTC --side sell --size 0.1 --entry limit --price 100000 --tp 5 --sl 2

  # Preview bracket setup
  npx tsx scripts/operations/bracket.ts --coin SOL --side buy --size 10 --tp 5 --sl 2 --dry
`);
}

export interface BracketOptions {
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  tpPct: number;
  slPct: number;
  entryType?: 'market' | 'limit';
  entryPrice?: number;
  slippage?: number;
  leverage?: number;
  dryRun?: boolean;
  verbose?: boolean;
  /** Receives each output line. Defaults to console.log. */
  output?: (line: string) => void;
}

export interface BracketResult {
  status: 'dry' | 'limit_resting' | 'complete' | 'entry_failed' | 'partial';
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  tpOid?: number | null;
  slOid?: number | null;
  entryOid?: number | null;
  reason?: string;
}

export async function runBracket(opts: BracketOptions): Promise<BracketResult> {
  const out = opts.output ?? ((line: string) => console.log(line));
  const entryType = opts.entryType ?? 'market';
  const isLong = opts.side === 'buy';

  if (opts.size <= 0 || isNaN(opts.size)) throw new Error('size must be positive');
  if (opts.tpPct <= 0 || opts.slPct <= 0) throw new Error('tp and sl must be positive percentages');
  if (entryType === 'limit' && opts.entryPrice === undefined) {
    throw new Error('entryPrice is required for limit entry');
  }

  const client = getClient();
  if (opts.verbose) client.verbose = true;

  out('Open Broker - Bracket Order');
  out('===========================\n');

  const mids = await client.getAllMids();
  const midPrice = parseFloat(mids[opts.coin]);
  if (!midPrice) throw new Error(`No market data for ${opts.coin}`);

  const entry = entryType === 'limit' ? opts.entryPrice! : midPrice;

  let tpPrice = isLong
    ? entry * (1 + opts.tpPct / 100)
    : entry * (1 - opts.tpPct / 100);
  let slPrice = isLong
    ? entry * (1 - opts.slPct / 100)
    : entry * (1 + opts.slPct / 100);

  const riskReward = opts.tpPct / opts.slPct;
  const notional = entry * opts.size;

  out('Bracket Plan');
  out('------------');
  out(`Coin:           ${opts.coin}`);
  out(`Position:       ${isLong ? 'LONG' : 'SHORT'}`);
  out(`Size:           ${opts.size}`);
  out(`Entry Type:     ${entryType.toUpperCase()}`);
  out(`Current Mid:    ${formatUsd(midPrice)}`);
  out(`Entry Price:    ${formatUsd(entry)}${entryType === 'market' ? ' (approx)' : ''}`);
  out(`Take Profit:    ${formatUsd(tpPrice)} (+${opts.tpPct}%)`);
  out(`Stop Loss:      ${formatUsd(slPrice)} (-${opts.slPct}%)`);
  out(`Risk/Reward:    1:${riskReward.toFixed(2)}`);
  out(`Est. Notional:  ${formatUsd(notional)}`);

  const potentialProfit = notional * (opts.tpPct / 100);
  const potentialLoss = notional * (opts.slPct / 100);
  out('\nRisk Analysis');
  out('-------------');
  out(`Potential Profit: ${formatUsd(potentialProfit)}`);
  out(`Potential Loss:   ${formatUsd(potentialLoss)}`);

  if (opts.dryRun) {
    out('\n🔍 Dry run - bracket not executed');
    return { status: 'dry', entryPrice: entry, tpPrice, slPrice };
  }

  out('\nExecuting bracket...\n');

  // Step 1: Entry
  out('Step 1: Entry order');
  let actualEntry = entry;
  let entryOid: number | null = null;

  if (entryType === 'market') {
    const entryResponse = await client.marketOrder(opts.coin, isLong, opts.size, opts.slippage, opts.leverage);

    if (entryResponse.status === 'ok' && entryResponse.response && typeof entryResponse.response === 'object') {
      const status = entryResponse.response.data.statuses[0];
      if (status?.filled) {
        actualEntry = parseFloat(status.filled.avgPx);
        out(`  ✅ Filled @ ${formatUsd(actualEntry)}`);
      } else if (status?.error) {
        out(`  ❌ Entry failed: ${status.error}`);
        out('\n⚠️ Bracket aborted - no position opened');
        return { status: 'entry_failed', reason: status.error };
      }
    } else {
      const reason = typeof entryResponse.response === 'string' ? entryResponse.response : 'Unknown error';
      out(`  ❌ Entry failed: ${reason}`);
      out('\n⚠️ Bracket aborted - no position opened');
      return { status: 'entry_failed', reason };
    }
  } else {
    const entryResponse = await client.limitOrder(opts.coin, isLong, opts.size, entry, 'Gtc', false, opts.leverage);

    if (entryResponse.status === 'ok' && entryResponse.response && typeof entryResponse.response === 'object') {
      const status = entryResponse.response.data.statuses[0];
      if (status?.resting) {
        entryOid = status.resting.oid;
        out(`  ✅ Limit order placed @ ${formatUsd(entry)} (OID: ${entryOid})`);
        out(`  ⏳ Waiting for fill before placing TP/SL...`);
        out('\n⚠️ Note: TP/SL will be placed after entry fills. Monitor manually or use a strategy script.');
        return { status: 'limit_resting', entryOid, entryPrice: entry };
      } else if (status?.filled) {
        actualEntry = parseFloat(status.filled.avgPx);
        out(`  ✅ Filled immediately @ ${formatUsd(actualEntry)}`);
      } else if (status?.error) {
        out(`  ❌ Entry failed: ${status.error}`);
        return { status: 'entry_failed', reason: status.error };
      }
    } else {
      out(`  ❌ Entry failed`);
      return { status: 'entry_failed', reason: 'Unknown error' };
    }
  }

  // Recalculate TP/SL based on actual entry
  if (isLong) {
    tpPrice = actualEntry * (1 + opts.tpPct / 100);
    slPrice = actualEntry * (1 - opts.slPct / 100);
  } else {
    tpPrice = actualEntry * (1 - opts.tpPct / 100);
    slPrice = actualEntry * (1 + opts.slPct / 100);
  }

  await sleep(500);

  // Step 2: Take Profit (trigger order)
  out('\nStep 2: Take Profit order (trigger)');
  const tpSide = !isLong;
  const tpResponse = await client.takeProfit(opts.coin, tpSide, opts.size, tpPrice);

  let tpOid: number | null = null;
  if (tpResponse.status === 'ok' && tpResponse.response && typeof tpResponse.response === 'object') {
    const status = tpResponse.response.data.statuses[0];
    if (status?.resting) {
      tpOid = status.resting.oid;
      out(`  ✅ TP trigger placed @ ${formatUsd(tpPrice)} (OID: ${tpOid})`);
    } else if (status?.error) {
      out(`  ❌ TP failed: ${status.error}`);
    } else {
      out(`  ⚠️ TP status: ${JSON.stringify(status)}`);
    }
  } else {
    const reason = typeof tpResponse.response === 'string' ? tpResponse.response : 'Unknown error';
    out(`  ❌ TP failed: ${reason}`);
  }

  await sleep(500);

  // Step 3: Stop Loss (trigger order)
  out('\nStep 3: Stop Loss order (trigger)');
  const slSide = !isLong;
  const slResponse = await client.stopLoss(opts.coin, slSide, opts.size, slPrice);

  let slOid: number | null = null;
  if (slResponse.status === 'ok' && slResponse.response && typeof slResponse.response === 'object') {
    const status = slResponse.response.data.statuses[0];
    if (status?.resting) {
      slOid = status.resting.oid;
      out(`  ✅ SL trigger placed @ ${formatUsd(slPrice)} (OID: ${slOid})`);
    } else if (status?.error) {
      out(`  ❌ SL failed: ${status.error}`);
    } else {
      out(`  ⚠️ SL status: ${JSON.stringify(status)}`);
    }
  } else {
    const reason = typeof slResponse.response === 'string' ? slResponse.response : 'Unknown error';
    out(`  ❌ SL failed: ${reason}`);
  }

  out('\n========== Bracket Summary ==========');
  out(`Position:    ${isLong ? 'LONG' : 'SHORT'} ${opts.size} ${opts.coin}`);
  out(`Entry:       ${formatUsd(actualEntry)}`);
  out(`Take Profit: ${formatUsd(tpPrice)} (+${opts.tpPct}%) - Trigger order`);
  out(`Stop Loss:   ${formatUsd(slPrice)} (-${opts.slPct}%) - Trigger order`);
  if (tpOid && slOid) {
    out(`\n✅ Bracket complete! TP and SL are trigger orders.`);
    out(`   They will only execute when price reaches trigger level.`);
    out(`   When one fills, cancel the other manually.`);
  }

  return {
    status: tpOid && slOid ? 'complete' : 'partial',
    entryPrice: actualEntry,
    tpPrice,
    slPrice,
    tpOid,
    slOid,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const coin = args.coin as string;
  const side = args.side as string;
  const size = parseFloat(args.size as string);
  const entryType = (args.entry as string || 'market') as 'market' | 'limit';
  const entryPrice = args.price ? parseFloat(args.price as string) : undefined;
  const tpPct = parseFloat(args.tp as string);
  const slPct = parseFloat(args.sl as string);
  const slippage = args.slippage ? parseInt(args.slippage as string) : undefined;
  const leverage = args.leverage ? parseInt(args.leverage as string) : undefined;
  const dryRun = args.dry as boolean;

  if (!coin || !side || isNaN(size) || isNaN(tpPct) || isNaN(slPct)) {
    printUsage();
    process.exit(1);
  }
  if (side !== 'buy' && side !== 'sell') {
    console.error('Error: --side must be "buy" or "sell"');
    process.exit(1);
  }

  try {
    const result = await runBracket({
      coin,
      side: side as 'buy' | 'sell',
      size,
      tpPct,
      slPct,
      entryType,
      entryPrice,
      slippage,
      leverage,
      dryRun,
      verbose: args.verbose as boolean,
    });
    if (result.status === 'entry_failed') process.exit(1);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Only run when invoked as a script — not when imported as a module
// (e.g. by `openbroker-plugin` via the lib re-export of `runBracket`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
