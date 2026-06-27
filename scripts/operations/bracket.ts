#!/usr/bin/env npx tsx
// Bracket Order - Entry with Take Profit and Stop Loss

import { fileURLToPath } from 'url';
import { getClient } from '../core/client.js';
import type { OrderResponse } from '../core/types.js';
import { formatUsd, parseArgs, sleep } from '../core/utils.js';
import { UserFillWatcher, type FillWatcher } from './execution.js';

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
  --entry-timeout Seconds to wait for limit entry fill before returning (default: 300)
  --sl-slippage Stop-loss trigger limit slippage in bps (default: 100)
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
  entryTimeoutSec?: number;
  slSlippageBps?: number;
  leverage?: number;
  dryRun?: boolean;
  verbose?: boolean;
  client?: BracketClient;
  fillWatcher?: FillWatcher;
  /** Receives each output line. Defaults to console.log. */
  output?: (line: string) => void;
}

export interface BracketClient {
  verbose: boolean;
  getAllMids(): Promise<Record<string, string>>;
  marketOrder(coin: string, isBuy: boolean, size: number, slippageBps?: number, leverage?: number): Promise<OrderResponse>;
  limitOrder(coin: string, isBuy: boolean, size: number, price: number, tif?: 'Gtc' | 'Ioc' | 'Alo', reduceOnly?: boolean, leverage?: number): Promise<OrderResponse>;
  tpslPair(coin: string, isBuy: boolean, size: number, takeProfitPrice: number, stopLossPrice: number, stopLossSlippageBps?: number, leverage?: number): Promise<OrderResponse>;
  address: string;
  getUserFills(user?: string): Promise<Array<{ coin: string; px: string; sz: string; time: number; oid: number }>>;
}

export interface BracketResult {
  status: 'dry' | 'limit_resting' | 'complete' | 'entry_failed' | 'partial';
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  tpOid?: number | null;
  slOid?: number | null;
  entryOid?: number | null;
  protectedSize?: number;
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

  const client = opts.client ?? getClient();
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
  let filledSize = 0;
  const ownsFillWatcher = !opts.fillWatcher;
  const fillWatcher = opts.fillWatcher ?? new UserFillWatcher(client, { sinceMs: Date.now() });

  await fillWatcher.start();

  try {
    if (entryType === 'market') {
      const entryResponse = await client.marketOrder(opts.coin, isLong, opts.size, opts.slippage, opts.leverage);

      if (entryResponse.status === 'ok' && entryResponse.response && typeof entryResponse.response === 'object') {
        const status = entryResponse.response.data.statuses[0];
        if (status?.filled) {
          actualEntry = parseFloat(status.filled.avgPx);
          filledSize = parseFloat(status.filled.totalSz);
          out(`  ✅ Filled ${filledSize} @ ${formatUsd(actualEntry)}`);
        } else if (status?.error) {
          out(`  ❌ Entry failed: ${status.error}`);
          out('\n⚠️ Bracket aborted - no position opened');
          return { status: 'entry_failed', reason: status.error };
        } else {
          out(`  ❌ Entry failed: unexpected response`);
          out('\n⚠️ Bracket aborted - no confirmed position opened');
          return { status: 'entry_failed', reason: 'Unexpected entry response' };
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
          const entryTimeoutSec = opts.entryTimeoutSec ?? 300;
          out(`  ✅ Limit order placed @ ${formatUsd(entry)} (OID: ${entryOid})`);

          if (entryTimeoutSec <= 0) {
            out(`  ⏳ Entry resting; TP/SL not armed until a fill is confirmed.`);
            return { status: 'limit_resting', entryOid, entryPrice: entry };
          }

          out(`  ⏳ Waiting up to ${entryTimeoutSec}s for fill confirmation...`);
          const fill = await fillWatcher.waitForFill(entryOid, opts.size, entryTimeoutSec * 1000, { coin: opts.coin });
          if (fill.size <= 0) {
            out(`  ⚠️ Entry still resting after ${entryTimeoutSec}s; TP/SL not armed.`);
            return { status: 'limit_resting', entryOid, entryPrice: entry };
          }
          filledSize = Math.min(fill.size, opts.size);
          actualEntry = fill.avgPrice ?? entry;
          out(`  ✅ Fill confirmed: ${filledSize} @ ${formatUsd(actualEntry)}`);
          if (filledSize < opts.size * 0.999) {
            out(`  ⚠️ Partial entry fill; arming TP/SL for filled size only.`);
          }
        } else if (status?.filled) {
          actualEntry = parseFloat(status.filled.avgPx);
          filledSize = parseFloat(status.filled.totalSz);
          out(`  ✅ Filled immediately ${filledSize} @ ${formatUsd(actualEntry)}`);
        } else if (status?.error) {
          out(`  ❌ Entry failed: ${status.error}`);
          return { status: 'entry_failed', reason: status.error };
        } else {
          out(`  ❌ Entry failed: unexpected response`);
          return { status: 'entry_failed', reason: 'Unexpected entry response' };
        }
      } else {
        out(`  ❌ Entry failed`);
        return { status: 'entry_failed', reason: 'Unknown error' };
      }
    }
  } finally {
    if (ownsFillWatcher) await fillWatcher.stop();
  }

  if (!Number.isFinite(filledSize) || filledSize <= 0) {
    out('\n⚠️ Bracket aborted - no confirmed fill size');
    return { status: 'entry_failed', reason: 'No confirmed fill size' };
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

  // Step 2: Paired TP/SL trigger orders
  out('\nStep 2: Paired TP/SL trigger orders');
  const exitSide = !isLong;
  const pairResponse = await client.tpslPair(
    opts.coin,
    exitSide,
    filledSize,
    tpPrice,
    slPrice,
    opts.slSlippageBps,
    opts.leverage,
  );

  let tpOid: number | null = null;
  let slOid: number | null = null;
  if (pairResponse.status === 'ok' && pairResponse.response && typeof pairResponse.response === 'object') {
    const [tpStatus, slStatus] = pairResponse.response.data.statuses;
    if (tpStatus?.resting) {
      tpOid = tpStatus.resting.oid;
      out(`  ✅ TP trigger placed @ ${formatUsd(tpPrice)} (OID: ${tpOid})`);
    } else if (tpStatus?.error) {
      out(`  ❌ TP failed: ${tpStatus.error}`);
    } else {
      out(`  ⚠️ TP status: ${JSON.stringify(tpStatus)}`);
    }

    if (slStatus?.resting) {
      slOid = slStatus.resting.oid;
      out(`  ✅ SL trigger placed @ ${formatUsd(slPrice)} (OID: ${slOid})`);
    } else if (slStatus?.error) {
      out(`  ❌ SL failed: ${slStatus.error}`);
    } else {
      out(`  ⚠️ SL status: ${JSON.stringify(slStatus)}`);
    }
  } else {
    const reason = typeof pairResponse.response === 'string' ? pairResponse.response : 'Unknown error';
    out(`  ❌ TP/SL pair failed: ${reason}`);
  }

  out('\n========== Bracket Summary ==========');
  out(`Position:    ${isLong ? 'LONG' : 'SHORT'} ${filledSize} ${opts.coin}`);
  out(`Entry:       ${formatUsd(actualEntry)}`);
  out(`Take Profit: ${formatUsd(tpPrice)} (+${opts.tpPct}%) - Trigger order`);
  out(`Stop Loss:   ${formatUsd(slPrice)} (-${opts.slPct}%) - Trigger order`);
  if (tpOid && slOid) {
    out(`\n✅ Bracket complete! TP and SL are linked trigger orders.`);
  }

  return {
    status: tpOid && slOid ? 'complete' : 'partial',
    entryPrice: actualEntry,
    tpPrice,
    slPrice,
    tpOid,
    slOid,
    protectedSize: filledSize,
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
  const entryTimeoutSec = args['entry-timeout'] ? parseInt(args['entry-timeout'] as string) : undefined;
  const slSlippageBps = args['sl-slippage'] ? parseInt(args['sl-slippage'] as string) : undefined;
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
      entryTimeoutSec,
      slSlippageBps,
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
