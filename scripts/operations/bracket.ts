#!/usr/bin/env npx tsx
// Bracket Order - Entry with Take Profit and Stop Loss

import { fileURLToPath } from 'url';
import { getClient } from '../core/client.js';
import type { CancelResponse, OrderResponse } from '../core/types.js';
import { formatUsd, parseArgs, parseOrderStatus, sleep } from '../core/utils.js';
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
  --tp-price    Take profit at an absolute price (instead of --tp)
  --sl-price    Stop loss at an absolute price (instead of --sl)
  --slippage    Slippage for market entry in bps (default: 50)
  --entry-timeout Seconds to wait for limit entry fill before returning
                (default: 300; only used with --no-atomic)
  --sl-slippage Stop-loss fill cap past the trigger in bps (default: 100)
  --sl-limit    Place the SL as a stop-limit instead of a market trigger.
                Warning: a gap move past the limit band can skip the stop
                entirely and leave the position unprotected.
  --no-atomic   For limit entries: place the entry alone and arm TP/SL only
                after a confirmed fill, instead of the default atomic batch
                where the exchange arms TP/SL on fill server-side.
  --leverage    Set leverage (e.g., 10 for 10x). Cross for main perps, isolated for HIP-3
  --dry         Dry run - show bracket plan without executing

At least one of --tp/--tp-price/--sl/--sl-price is required; one-sided
brackets (TP-only or SL-only) are supported.

Take Profit / Stop Loss:
  For LONG (buy): TP is above entry, SL is below entry
  For SHORT (sell): TP is below entry, SL is above entry

Examples:
  # Long ETH with 3% take profit and 1.5% stop loss
  npx tsx scripts/operations/bracket.ts --coin ETH --side buy --size 0.5 --tp 3 --sl 1.5

  # Short BTC with limit entry at $100k, 5% TP, 2% SL (armed atomically on fill)
  npx tsx scripts/operations/bracket.ts --coin BTC --side sell --size 0.1 --entry limit --price 100000 --tp 5 --sl 2

  # Long with absolute targets, SL only
  npx tsx scripts/operations/bracket.ts --coin SOL --side buy --size 10 --sl-price 120

  # Preview bracket setup
  npx tsx scripts/operations/bracket.ts --coin SOL --side buy --size 10 --tp 5 --sl 2 --dry
`);
}

export interface BracketOptions {
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  /** Take profit distance in % from entry. Optional if tpPrice/sl* given. */
  tpPct?: number;
  /** Stop loss distance in % from entry. Optional if slPrice/tp* given. */
  slPct?: number;
  /** Absolute take profit price (takes precedence over tpPct). */
  tpPrice?: number;
  /** Absolute stop loss trigger price (takes precedence over slPct). */
  slPrice?: number;
  entryType?: 'market' | 'limit';
  entryPrice?: number;
  slippage?: number;
  entryTimeoutSec?: number;
  slSlippageBps?: number;
  /** SL fires as a market trigger (default true); false = stop-limit. */
  slMarket?: boolean;
  /**
   * Limit entries only: submit entry + TP/SL as one atomic normalTpsl batch
   * (default true) — the exchange arms the exits when the entry fills, so the
   * bracket survives this process exiting. false = legacy fill-watch path.
   */
  atomic?: boolean;
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
  tpslOrders(coin: string, isBuy: boolean, size: number, opts?: {
    takeProfitPrice?: number;
    stopLossPrice?: number;
    stopLossSlippageBps?: number;
    stopLossIsMarket?: boolean;
    grouping?: 'positionTpsl' | 'normalTpsl';
    leverage?: number;
  }): Promise<OrderResponse>;
  bracketOrder(coin: string, isBuy: boolean, size: number, entryPrice: number, opts?: {
    entryTif?: 'Gtc' | 'Alo';
    takeProfitPrice?: number;
    stopLossPrice?: number;
    stopLossSlippageBps?: number;
    stopLossIsMarket?: boolean;
    leverage?: number;
  }): Promise<OrderResponse>;
  cancel(coin: string, oid: number): Promise<CancelResponse>;
  address: string;
  getUserFills(user?: string): Promise<Array<{ coin: string; px: string; sz: string; time: number; oid: number }>>;
}

export interface BracketResult {
  status: 'dry' | 'armed' | 'limit_resting' | 'complete' | 'entry_failed' | 'partial';
  entryPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  tpOid?: number | null;
  slOid?: number | null;
  entryOid?: number | null;
  protectedSize?: number;
  reason?: string;
}

interface ResolvedTargets {
  tpPrice: number | null;
  slPrice: number | null;
}

export async function runBracket(opts: BracketOptions): Promise<BracketResult> {
  const out = opts.output ?? ((line: string) => console.log(line));
  const entryType = opts.entryType ?? 'market';
  const slMarket = opts.slMarket !== false;
  const atomic = opts.atomic !== false;
  const isLong = opts.side === 'buy';

  const hasTp = (opts.tpPct ?? 0) > 0 || (opts.tpPrice ?? 0) > 0;
  const hasSl = (opts.slPct ?? 0) > 0 || (opts.slPrice ?? 0) > 0;

  if (opts.size <= 0 || isNaN(opts.size)) throw new Error('size must be positive');
  if (!hasTp && !hasSl) throw new Error('provide a TP target, an SL target, or both (tpPct/tpPrice/slPct/slPrice)');
  if (entryType === 'limit' && opts.entryPrice === undefined) {
    throw new Error('entryPrice is required for limit entry');
  }

  // Resolve percent targets off the reference entry and validate every provided leg.
  const resolveTargets = (entryPrice: number): ResolvedTargets => {
    const tpPrice = !hasTp
      ? null
      : (opts.tpPrice ?? 0) > 0
        ? opts.tpPrice!
        : isLong
          ? entryPrice * (1 + opts.tpPct! / 100)
          : entryPrice * (1 - opts.tpPct! / 100);
    const slPrice = !hasSl
      ? null
      : (opts.slPrice ?? 0) > 0
        ? opts.slPrice!
        : isLong
          ? entryPrice * (1 - opts.slPct! / 100)
          : entryPrice * (1 + opts.slPct! / 100);
    if (tpPrice !== null && tpPrice <= 0) throw new Error('TP must resolve to a positive price (keep TP% under 100 on shorts)');
    if (slPrice !== null && slPrice <= 0) throw new Error('SL must resolve to a positive price (keep SL% under 100)');
    if (isLong) {
      if (tpPrice !== null && tpPrice <= entryPrice) throw new Error('for a long, TP price must be above entry');
      if (slPrice !== null && slPrice >= entryPrice) throw new Error('for a long, SL price must be below entry');
    } else {
      if (tpPrice !== null && tpPrice >= entryPrice) throw new Error('for a short, TP price must be below entry');
      if (slPrice !== null && slPrice <= entryPrice) throw new Error('for a short, SL price must be above entry');
    }
    return { tpPrice, slPrice };
  };

  const client = opts.client ?? getClient();
  if (opts.verbose) client.verbose = true;

  out('Open Broker - Bracket Order');
  out('===========================\n');

  const mids = await client.getAllMids();
  const midPrice = parseFloat(mids[opts.coin]);
  if (!midPrice) throw new Error(`No market data for ${opts.coin}`);

  const entry = entryType === 'limit' ? opts.entryPrice! : midPrice;

  // Validate targets against the pre-trade reference BEFORE the entry goes out,
  // so a bad TP/SL never leaves an unprotected position behind.
  let targets = resolveTargets(entry);

  const legsLabel = hasTp && hasSl ? 'TP/SL' : hasTp ? 'TP' : 'SL';
  const tpDistPct = targets.tpPrice !== null ? Math.abs(targets.tpPrice - entry) / entry * 100 : null;
  const slDistPct = targets.slPrice !== null ? Math.abs(targets.slPrice - entry) / entry * 100 : null;
  const notional = entry * opts.size;

  out('Bracket Plan');
  out('------------');
  out(`Coin:           ${opts.coin}`);
  out(`Position:       ${isLong ? 'LONG' : 'SHORT'}`);
  out(`Size:           ${opts.size}`);
  out(`Entry Type:     ${entryType.toUpperCase()}${entryType === 'limit' ? (atomic ? ' (atomic TP/SL)' : ' (fill-watch TP/SL)') : ''}`);
  out(`Current Mid:    ${formatUsd(midPrice)}`);
  out(`Entry Price:    ${formatUsd(entry)}${entryType === 'market' ? ' (approx)' : ''}`);
  if (targets.tpPrice !== null) out(`Take Profit:    ${formatUsd(targets.tpPrice)} (${tpDistPct!.toFixed(2)}% from entry)`);
  if (targets.slPrice !== null) out(`Stop Loss:      ${formatUsd(targets.slPrice)} (${slDistPct!.toFixed(2)}% from entry, ${slMarket ? 'market trigger' : 'stop-limit'})`);
  if (tpDistPct !== null && slDistPct !== null && slDistPct > 0) {
    out(`Risk/Reward:    1:${(tpDistPct / slDistPct).toFixed(2)}`);
  }
  out(`Est. Notional:  ${formatUsd(notional)}`);

  out('\nRisk Analysis');
  out('-------------');
  if (targets.tpPrice !== null) out(`Potential Profit: ${formatUsd(Math.abs(targets.tpPrice - entry) * opts.size)}`);
  if (targets.slPrice !== null) out(`Potential Loss:   ${formatUsd(Math.abs(entry - targets.slPrice) * opts.size)}`);

  if (opts.dryRun) {
    out('\n🔍 Dry run - bracket not executed');
    return { status: 'dry', entryPrice: entry, tpPrice: targets.tpPrice ?? undefined, slPrice: targets.slPrice ?? undefined };
  }

  out('\nExecuting bracket...\n');

  // ── Atomic path: limit entry + TP/SL in one normalTpsl batch ──────────
  // The exchange arms the exits when the entry fills (children come back as
  // "waitingForFill"), so the bracket survives this process exiting.
  if (entryType === 'limit' && atomic) {
    out(`Step 1: Limit entry + ${legsLabel} (atomic normalTpsl batch)`);
    const response = await client.bracketOrder(opts.coin, isLong, opts.size, entry, {
      takeProfitPrice: targets.tpPrice ?? undefined,
      stopLossPrice: targets.slPrice ?? undefined,
      stopLossSlippageBps: opts.slSlippageBps,
      stopLossIsMarket: slMarket,
      leverage: opts.leverage,
    });

    if (response.status !== 'ok' || !response.response || typeof response.response !== 'object') {
      const reason = typeof response.response === 'string' ? response.response : 'Unknown error';
      out(`  ❌ Bracket failed: ${reason}`);
      return { status: 'entry_failed', reason };
    }

    const statuses = response.response.data.statuses.map(parseOrderStatus);
    const entryStatus = statuses[0];
    const childStatuses = statuses.slice(1);
    const failed = statuses.find((s) => s.kind === 'error' || s.kind === 'unknown');
    if (failed) {
      // Roll back anything that landed so no half-armed bracket is left behind.
      const restingOids = statuses.flatMap((s) => (s.kind === 'resting' ? [s.oid] : []));
      for (const oid of restingOids) {
        try { await client.cancel(opts.coin, oid); } catch { /* may have filled */ }
      }
      const reason = failed.kind === 'error' ? failed.error : `Unexpected order status: ${JSON.stringify(failed)}`;
      out(`  ❌ Bracket rejected: ${reason}`);
      if (restingOids.length) out(`  Cancelled ${restingOids.length} resting order(s).`);
      return { status: 'entry_failed', reason };
    }

    let entryOid: number | null = null;
    let filledEntry: { size: number; avgPx: number } | null = null;
    if (entryStatus.kind === 'resting') {
      entryOid = entryStatus.oid;
      out(`  ✅ Entry resting @ ${formatUsd(entry)} (OID: ${entryOid})`);
    } else if (entryStatus.kind === 'filled') {
      entryOid = entryStatus.oid;
      filledEntry = { size: entryStatus.totalSz, avgPx: entryStatus.avgPx };
      out(`  ✅ Entry filled immediately: ${entryStatus.totalSz} @ ${formatUsd(entryStatus.avgPx)}`);
    }

    let tpOid: number | null = null;
    let slOid: number | null = null;
    let childIdx = 0;
    for (const label of [targets.tpPrice !== null ? 'TP' : null, targets.slPrice !== null ? 'SL' : null]) {
      if (!label) continue;
      const child = childStatuses[childIdx++];
      if (!child) continue;
      if (child.kind === 'waiting') {
        out(`  ✅ ${label} armed — activates when the entry fills (${child.state})`);
      } else if (child.kind === 'resting') {
        if (label === 'TP') tpOid = child.oid; else slOid = child.oid;
        out(`  ✅ ${label} trigger live (OID: ${child.oid})`);
      }
    }

    out('\n========== Bracket Summary ==========');
    out(`Position:    ${isLong ? 'LONG' : 'SHORT'} ${opts.size} ${opts.coin}`);
    out(`Entry:       ${formatUsd(filledEntry?.avgPx ?? entry)}${filledEntry ? '' : ' (resting)'}`);
    if (targets.tpPrice !== null) out(`Take Profit: ${formatUsd(targets.tpPrice)}`);
    if (targets.slPrice !== null) out(`Stop Loss:   ${formatUsd(targets.slPrice)} (${slMarket ? 'market trigger' : 'stop-limit'})`);
    out(filledEntry
      ? `\n✅ Bracket complete! ${legsLabel} triggers are live.`
      : `\n✅ Bracket armed! ${legsLabel} activates server-side when the entry fills.`);

    return {
      status: filledEntry ? 'complete' : 'armed',
      entryPrice: filledEntry?.avgPx ?? entry,
      tpPrice: targets.tpPrice ?? undefined,
      slPrice: targets.slPrice ?? undefined,
      tpOid,
      slOid,
      entryOid,
      protectedSize: filledEntry?.size ?? opts.size,
    };
  }

  // ── Fill-first path: market entry, or limit entry with --no-atomic ────
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

  // Re-resolve off the actual fill price; if the fill drifted past a fixed
  // target, report it instead of leaving a half-armed bracket silently.
  try {
    targets = resolveTargets(actualEntry);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    out(`\n❌ Entry filled @ ${formatUsd(actualEntry)}, but ${legsLabel} could not be armed: ${reason}`);
    out('⚠️ Position is OPEN and UNPROTECTED - set TP/SL manually (openbroker set-tpsl).');
    return { status: 'partial', entryPrice: actualEntry, protectedSize: 0, reason };
  }

  await sleep(500);

  // Step 2: TP/SL triggers tied to the now-open position (positionTpsl) —
  // OCO between themselves and cancelled by the venue if the position closes.
  out(`\nStep 2: Position ${legsLabel} trigger orders`);
  const exitSide = !isLong;
  const pairResponse = await client.tpslOrders(opts.coin, exitSide, filledSize, {
    takeProfitPrice: targets.tpPrice ?? undefined,
    stopLossPrice: targets.slPrice ?? undefined,
    stopLossSlippageBps: opts.slSlippageBps,
    stopLossIsMarket: slMarket,
    grouping: 'positionTpsl',
    leverage: opts.leverage,
  });

  let tpOid: number | null = null;
  let slOid: number | null = null;
  let exitErrors = 0;
  if (pairResponse.status === 'ok' && pairResponse.response && typeof pairResponse.response === 'object') {
    const statuses = pairResponse.response.data.statuses.map(parseOrderStatus);
    let idx = 0;
    for (const leg of [targets.tpPrice !== null ? 'TP' : null, targets.slPrice !== null ? 'SL' : null]) {
      if (!leg) continue;
      const status = statuses[idx++];
      const price = leg === 'TP' ? targets.tpPrice! : targets.slPrice!;
      if (status?.kind === 'resting') {
        if (leg === 'TP') tpOid = status.oid; else slOid = status.oid;
        out(`  ✅ ${leg} trigger placed @ ${formatUsd(price)} (OID: ${status.oid})`);
      } else if (status?.kind === 'waiting') {
        out(`  ✅ ${leg} trigger armed @ ${formatUsd(price)} (${status.state})`);
      } else if (status?.kind === 'error') {
        exitErrors++;
        out(`  ❌ ${leg} failed: ${status.error}`);
      } else {
        exitErrors++;
        out(`  ⚠️ ${leg} status: ${JSON.stringify(status)}`);
      }
    }
  } else {
    exitErrors++;
    const reason = typeof pairResponse.response === 'string' ? pairResponse.response : 'Unknown error';
    out(`  ❌ ${legsLabel} orders failed: ${reason}`);
  }

  out('\n========== Bracket Summary ==========');
  out(`Position:    ${isLong ? 'LONG' : 'SHORT'} ${filledSize} ${opts.coin}`);
  out(`Entry:       ${formatUsd(actualEntry)}`);
  if (targets.tpPrice !== null) out(`Take Profit: ${formatUsd(targets.tpPrice)} - Trigger order`);
  if (targets.slPrice !== null) out(`Stop Loss:   ${formatUsd(targets.slPrice)} (${slMarket ? 'market trigger' : 'stop-limit'}) - Trigger order`);
  if (exitErrors === 0) {
    out(`\n✅ Bracket complete! ${legsLabel} triggers track the position (positionTpsl).`);
  } else {
    out('\n⚠️ Position is open but not fully protected - set the missing trigger manually.');
  }

  return {
    status: exitErrors === 0 ? 'complete' : 'partial',
    entryPrice: actualEntry,
    tpPrice: targets.tpPrice ?? undefined,
    slPrice: targets.slPrice ?? undefined,
    tpOid,
    slOid,
    entryOid,
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
  const tpPct = args.tp ? parseFloat(args.tp as string) : undefined;
  const slPct = args.sl ? parseFloat(args.sl as string) : undefined;
  const tpPrice = args['tp-price'] ? parseFloat(args['tp-price'] as string) : undefined;
  const slPrice = args['sl-price'] ? parseFloat(args['sl-price'] as string) : undefined;
  const slippage = args.slippage ? parseInt(args.slippage as string) : undefined;
  const entryTimeoutSec = args['entry-timeout'] ? parseInt(args['entry-timeout'] as string) : undefined;
  const slSlippageBps = args['sl-slippage'] ? parseInt(args['sl-slippage'] as string) : undefined;
  const leverage = args.leverage ? parseInt(args.leverage as string) : undefined;
  const dryRun = args.dry as boolean;

  const hasTarget = [tpPct, slPct, tpPrice, slPrice].some((v) => v !== undefined && !isNaN(v));
  if (!coin || !side || isNaN(size) || !hasTarget) {
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
      tpPrice,
      slPrice,
      entryType,
      entryPrice,
      slippage,
      entryTimeoutSec,
      slSlippageBps,
      slMarket: !(args['sl-limit'] as boolean),
      atomic: !(args['no-atomic'] as boolean),
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
