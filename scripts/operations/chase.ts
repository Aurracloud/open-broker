#!/usr/bin/env npx tsx
// Chase Order - Follow price with limit orders until filled

import { fileURLToPath } from 'url';
import { getClient } from '../core/client.js';
import type { OrderResponse, CancelResponse, OpenOrder } from '../core/types.js';
import { formatUsd, parseArgs, sleep } from '../core/utils.js';
import { UserFillWatcher, type FillWatcher } from './execution.js';

function printUsage() {
  console.log(`
Open Broker - Chase Order
=========================

Place a limit order that chases the price until filled.
Keeps adjusting the order to stay near the best price while avoiding taker fees.

Usage:
  npx tsx scripts/operations/chase.ts --coin <COIN> --side <buy|sell> --size <SIZE>

Options:
  --coin        Asset to trade (e.g., ETH, BTC)
  --side        Order side: buy or sell
  --size        Order size in base asset
  --offset      Offset from mid price in bps (default: 5 = 0.05%)
  --timeout     Max time to chase in seconds (default: 300 = 5 min)
  --interval    Update interval in ms (default: 2000)
  --max-chase   Max price to chase to in bps from start (default: 100 = 1%)
  --leverage    Set leverage (e.g., 10 for 10x). Cross for main perps, isolated for HIP-3
  --reduce      Reduce-only order
  --dry         Dry run - show chase parameters without executing

Examples:
  # Chase buy 0.5 ETH with 5 bps offset, 5 min timeout
  npx tsx scripts/operations/chase.ts --coin ETH --side buy --size 0.5

  # Chase sell with tighter offset and longer timeout
  npx tsx scripts/operations/chase.ts --coin BTC --side sell --size 0.1 --offset 2 --timeout 600
`);
}

export interface ChaseOptions {
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  offsetBps?: number;
  timeoutSec?: number;
  intervalMs?: number;
  maxChaseBps?: number;
  leverage?: number;
  reduceOnly?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  client?: ChaseClient;
  fillWatcher?: FillWatcher;
  /** Receives each output line. Defaults to console.log. */
  output?: (line: string) => void;
}

export interface ChaseClient {
  verbose: boolean;
  address: string;
  getAllMids(): Promise<Record<string, string>>;
  getOpenOrders(): Promise<OpenOrder[]>;
  getUserFills(user?: string): Promise<Array<{ coin: string; px: string; sz: string; time: number; oid: number }>>;
  limitOrder(coin: string, isBuy: boolean, size: number, price: number, tif?: 'Gtc' | 'Ioc' | 'Alo', reduceOnly?: boolean, leverage?: number): Promise<OrderResponse>;
  cancel(coin: string, oid: number): Promise<CancelResponse>;
}

export interface ChaseResult {
  status: 'dry' | 'filled' | 'timeout' | 'max_chase_exceeded';
  iterations: number;
  durationSec: number;
  startMid: number;
  endMid: number;
}

export async function runChase(opts: ChaseOptions): Promise<ChaseResult> {
  const out = opts.output ?? ((line: string) => console.log(line));
  const offsetBps = opts.offsetBps ?? 5;
  const timeoutSec = opts.timeoutSec ?? 300;
  const intervalMs = opts.intervalMs ?? 2000;
  const maxChaseBps = opts.maxChaseBps ?? 100;
  const isBuy = opts.side === 'buy';

  if (opts.size <= 0 || isNaN(opts.size)) throw new Error('size must be positive');
  if (offsetBps < 0 || !Number.isFinite(offsetBps)) throw new Error('offsetBps must be non-negative');
  if (timeoutSec <= 0 || !Number.isFinite(timeoutSec)) throw new Error('timeoutSec must be positive');
  if (intervalMs <= 0 || !Number.isFinite(intervalMs)) throw new Error('intervalMs must be positive');
  if (maxChaseBps <= 0 || !Number.isFinite(maxChaseBps)) throw new Error('maxChaseBps must be positive');

  const client = opts.client ?? getClient();
  if (opts.verbose) client.verbose = true;

  out('Open Broker - Chase Order');
  out('=========================\n');

  const mids = await client.getAllMids();
  const startMid = parseFloat(mids[opts.coin]);
  if (!startMid) throw new Error(`No market data for ${opts.coin}`);

  const maxChasePrice = isBuy
    ? startMid * (1 + maxChaseBps / 10000)
    : startMid * (1 - maxChaseBps / 10000);

  out('Chase Parameters');
  out('----------------');
  out(`Coin:          ${opts.coin}`);
  out(`Side:          ${isBuy ? 'BUY' : 'SELL'}`);
  out(`Size:          ${opts.size}`);
  out(`Start Mid:     ${formatUsd(startMid)}`);
  out(`Offset:        ${offsetBps} bps (${(offsetBps / 100).toFixed(2)}%)`);
  out(`Max Chase:     ${maxChaseBps} bps to ${formatUsd(maxChasePrice)}`);
  out(`Timeout:       ${timeoutSec}s`);
  out(`Update Rate:   ${intervalMs}ms`);
  out(`Order Type:    ALO (post-only)`);

  if (opts.dryRun) {
    out('\n🔍 Dry run - chase not started');
    return { status: 'dry', iterations: 0, durationSec: 0, startMid, endMid: startMid };
  }

  out('\nChasing...\n');

  const startTime = Date.now();
  let currentOid: number | null = null;
  let lastPrice: number | null = null;
  let remainingSize = opts.size;
  let iteration = 0;
  let filled = false;
  let exitReason: 'filled' | 'timeout' | 'max_chase_exceeded' = 'timeout';
  const accountedFills = new Map<number, number>();
  const ownsFillWatcher = !opts.fillWatcher;
  const fillWatcher = opts.fillWatcher ?? new UserFillWatcher(client, { sinceMs: startTime });

  const applyFills = (oid: number): number => {
    const totalFilled = fillWatcher.getFilled(oid).size;
    const alreadyAccounted = accountedFills.get(oid) ?? 0;
    const delta = Math.max(0, totalFilled - alreadyAccounted);
    if (delta > 0) {
      remainingSize = Math.max(0, remainingSize - delta);
      accountedFills.set(oid, totalFilled);
    }
    return delta;
  };

  await fillWatcher.start();

  try {
    while (Date.now() - startTime < timeoutSec * 1000) {
      iteration++;

      if (currentOid !== null) {
        applyFills(currentOid);
        if (remainingSize <= opts.size * 0.001) {
          filled = true;
          exitReason = 'filled';
          out(`\n✅ Order filled!`);
          break;
        }
      }

      const currentMids = await client.getAllMids();
      const currentMid = parseFloat(currentMids[opts.coin]);
      if (!currentMid) throw new Error(`No market data for ${opts.coin}`);

      if (isBuy && currentMid > maxChasePrice) {
        out(`\n⚠️ Price ${formatUsd(currentMid)} exceeded max chase ${formatUsd(maxChasePrice)}`);
        exitReason = 'max_chase_exceeded';
        break;
      }
      if (!isBuy && currentMid < maxChasePrice) {
        out(`\n⚠️ Price ${formatUsd(currentMid)} exceeded max chase ${formatUsd(maxChasePrice)}`);
        exitReason = 'max_chase_exceeded';
        break;
      }

      const orderPrice = isBuy
        ? currentMid * (1 - offsetBps / 10000)
        : currentMid * (1 + offsetBps / 10000);

      const priceChanged = !lastPrice || Math.abs(orderPrice - lastPrice) / lastPrice > 0.0001;

      if (priceChanged) {
        if (currentOid !== null) {
          applyFills(currentOid);
          if (remainingSize <= opts.size * 0.001) {
            filled = true;
            exitReason = 'filled';
            out(`\n✅ Order filled!`);
            break;
          }
          try {
            await client.cancel(opts.coin, currentOid);
          } catch {
            // Order might have filled between the fill check and cancel.
          }
          applyFills(currentOid);
          currentOid = null;
        }

        if (remainingSize <= opts.size * 0.001) {
          filled = true;
          exitReason = 'filled';
          out(`\n✅ Order filled!`);
          break;
        }

        out(`[${iteration}] Mid: ${formatUsd(currentMid)} → Order: ${formatUsd(orderPrice)} x ${remainingSize.toFixed(6)}...`);

        const response = await client.limitOrder(opts.coin, isBuy, remainingSize, orderPrice, 'Alo', opts.reduceOnly, opts.leverage);

        if (response.status === 'ok' && response.response && typeof response.response === 'object') {
          const status = response.response.data.statuses[0];
          if (status?.resting) {
            currentOid = status.resting.oid;
            lastPrice = orderPrice;
            out(`OID: ${currentOid}`);
          } else if (status?.filled) {
            const totalSz = parseFloat(status.filled.totalSz);
            remainingSize = Math.max(0, remainingSize - totalSz);
            out(`✅ Filled ${totalSz} @ ${formatUsd(parseFloat(status.filled.avgPx))}`);
            if (remainingSize <= opts.size * 0.001) {
              filled = true;
              exitReason = 'filled';
              break;
            }
          } else if (status?.error) {
            out(`❌ ${status.error}`);
          }
        } else {
          out(`❌ Failed`);
        }
      } else {
        if (currentOid !== null) {
          await fillWatcher.waitForFill(currentOid, remainingSize, intervalMs, { coin: opts.coin, pollMs: intervalMs });
          applyFills(currentOid);
          if (remainingSize <= opts.size * 0.001) {
            filled = true;
            exitReason = 'filled';
            out(`\n✅ Order filled!`);
            break;
          }

          const orders = await client.getOpenOrders();
          const ourOrder = orders.find(o => o.oid === currentOid);
          if (!ourOrder) {
            applyFills(currentOid);
            if (remainingSize <= opts.size * 0.001) {
              filled = true;
              exitReason = 'filled';
              out(`\n✅ Order filled!`);
              break;
            }
            currentOid = null;
            lastPrice = null;
          }
        }
      }

      await sleep(intervalMs);
    }
  } finally {
    if (ownsFillWatcher) await fillWatcher.stop();
  }

  if (currentOid !== null && !filled) {
    applyFills(currentOid);
    out(`\nCancelling unfilled order...`);
    try {
      await client.cancel(opts.coin, currentOid);
      out(`✅ Cancelled`);
    } catch {
      out(`⚠️ Could not cancel (may have filled)`);
    }
    applyFills(currentOid);
    if (remainingSize <= opts.size * 0.001) {
      filled = true;
      exitReason = 'filled';
    }
  }

  const elapsed = (Date.now() - startTime) / 1000;
  const endMid = parseFloat((await client.getAllMids())[opts.coin]);
  const priceMove = ((endMid - startMid) / startMid) * 10000;

  out('\n========== Chase Summary ==========');
  out(`Duration:     ${elapsed.toFixed(1)}s`);
  out(`Iterations:   ${iteration}`);
  out(`Start Mid:    ${formatUsd(startMid)}`);
  out(`End Mid:      ${formatUsd(endMid)} (${priceMove >= 0 ? '+' : ''}${priceMove.toFixed(1)} bps)`);
  out(`Filled Size:  ${(opts.size - remainingSize).toFixed(6)} / ${opts.size}`);
  out(`Result:       ${filled ? '✅ Filled' : '❌ Not filled'}`);

  return { status: exitReason, iterations: iteration, durationSec: elapsed, startMid, endMid };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const coin = args.coin as string;
  const side = args.side as string;
  const size = parseFloat(args.size as string);

  if (!coin || !side || isNaN(size)) {
    printUsage();
    process.exit(1);
  }
  if (side !== 'buy' && side !== 'sell') {
    console.error('Error: --side must be "buy" or "sell"');
    process.exit(1);
  }

  try {
    await runChase({
      coin,
      side: side as 'buy' | 'sell',
      size,
      offsetBps: args.offset ? parseInt(args.offset as string) : undefined,
      timeoutSec: args.timeout ? parseInt(args.timeout as string) : undefined,
      intervalMs: args.interval ? parseInt(args.interval as string) : undefined,
      maxChaseBps: args['max-chase'] ? parseInt(args['max-chase'] as string) : undefined,
      leverage: args.leverage ? parseInt(args.leverage as string) : undefined,
      reduceOnly: args.reduce as boolean,
      dryRun: args.dry as boolean,
      verbose: args.verbose as boolean,
    });
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Only run when invoked as a script — not when imported as a module
// (e.g. by `openbroker-plugin` via the lib re-export of `runChase`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
