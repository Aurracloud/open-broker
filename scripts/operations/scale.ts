#!/usr/bin/env npx tsx
// Scale In/Out - Place a grid of limit orders

import { fileURLToPath } from 'url';
import { getClient } from '../core/client.js';
import type { CancelResponse, OrderResponse } from '../core/types.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - Scale In/Out
==========================

Place a grid of limit orders to scale into or out of a position.
Orders are distributed across price levels based on the specified range and distribution.

Usage:
  npx tsx scripts/operations/scale.ts --coin <COIN> --side <buy|sell> --size <SIZE> --levels <N> --range <PCT>

Options:
  --coin          Asset to trade (e.g., ETH, BTC)
  --side          Order side: buy or sell
  --size          Total order size in base asset
  --levels        Number of price levels (orders)
  --range         Price range from current mid (e.g., 2 for ±2%)
  --distribution  Size distribution: linear, exponential, or flat (default: linear)
                  - linear: more size at better prices
                  - exponential: much more size at better prices
                  - flat: equal size at all levels
  --leverage      Set leverage (e.g., 10 for 10x). Cross for main perps, isolated for HIP-3
  --reduce        Reduce-only orders (for scaling out of position)
  --tif           Time in force: GTC, ALO (default: GTC)
  --dry           Dry run - show order plan without executing

Examples:
  # Scale into 1 ETH with 5 buy orders, 2% below current price
  npx tsx scripts/operations/scale.ts --coin ETH --side buy --size 1 --levels 5 --range 2

  # Scale out of 0.5 BTC with 4 sell orders, 3% above current price (reduce-only)
  npx tsx scripts/operations/scale.ts --coin BTC --side sell --size 0.5 --levels 4 --range 3 --reduce

  # Use exponential distribution for more aggressive scaling
  npx tsx scripts/operations/scale.ts --coin ETH --side buy --size 2 --levels 8 --range 5 --distribution exponential
`);
}

export interface OrderLevel {
  level: number;
  price: number;
  size: number;
  distanceFromMid: number;
}

export interface ScaleClient {
  verbose: boolean;
  getAllMids(): Promise<Record<string, string>>;
  bulkOrder(
    orders: Array<{ coin: string; isBuy: boolean; size: number; price: number; tif?: 'Gtc' | 'Alo'; reduceOnly?: boolean; leverage?: number }>
  ): Promise<OrderResponse>;
  bulkCancel(cancels: Array<{ coin: string; oid: number }>): Promise<CancelResponse>;
}

export interface ScaleOptions {
  coin: string;
  side: 'buy' | 'sell';
  size: number;
  levels: number;
  rangePct: number;
  distribution?: 'linear' | 'exponential' | 'flat';
  leverage?: number;
  reduceOnly?: boolean;
  tif?: 'Gtc' | 'Alo';
  dryRun?: boolean;
  verbose?: boolean;
  rollbackOnPartial?: boolean;
  client?: ScaleClient;
  output?: (line: string) => void;
}

export interface ScaleResult {
  status: 'dry' | 'complete' | 'partial' | 'failed';
  levels: OrderLevel[];
  restingOids: number[];
  filledOids: number[];
  errors: string[];
  rolledBack: boolean;
}

export function calculateLevels(
  midPrice: number,
  isBuy: boolean,
  totalSize: number,
  numLevels: number,
  rangePct: number,
  distribution: 'linear' | 'exponential' | 'flat'
): OrderLevel[] {
  const levels: OrderLevel[] = [];

  // Calculate weights based on distribution
  let weights: number[] = [];
  for (let i = 0; i < numLevels; i++) {
    switch (distribution) {
      case 'flat':
        weights.push(1);
        break;
      case 'linear':
        weights.push(i + 1); // 1, 2, 3, 4, 5... (more at worse prices = better for buyer)
        break;
      case 'exponential':
        weights.push(Math.pow(2, i)); // 1, 2, 4, 8, 16...
        break;
    }
  }

  const totalWeight = weights.reduce((a, b) => a + b, 0);

  // Calculate price levels
  for (let i = 0; i < numLevels; i++) {
    // Distance increases with level (i=0 is closest to mid)
    const distancePct = ((i + 1) / numLevels) * rangePct;

    // Buy orders go below mid, sell orders go above
    const price = isBuy
      ? midPrice * (1 - distancePct / 100)
      : midPrice * (1 + distancePct / 100);

    const size = (weights[i] / totalWeight) * totalSize;

    levels.push({
      level: i + 1,
      price,
      size,
      distanceFromMid: distancePct,
    });
  }

  return levels;
}

export async function runScale(opts: ScaleOptions): Promise<ScaleResult> {
  const out = opts.output ?? ((line: string) => console.log(line));
  const distribution = opts.distribution ?? 'linear';
  const reduceOnly = opts.reduceOnly ?? false;
  const tif = opts.tif ?? 'Gtc';
  const rollbackOnPartial = opts.rollbackOnPartial ?? true;
  const isBuy = opts.side === 'buy';

  if (!opts.coin) throw new Error('coin is required');
  if (opts.side !== 'buy' && opts.side !== 'sell') throw new Error('side must be buy or sell');
  if (!Number.isFinite(opts.size) || opts.size <= 0) throw new Error('size must be positive');
  if (!Number.isInteger(opts.levels) || opts.levels <= 0) throw new Error('levels must be a positive integer');
  if (!Number.isFinite(opts.rangePct) || opts.rangePct <= 0) throw new Error('rangePct must be positive');
  if (!['linear', 'exponential', 'flat'].includes(distribution)) throw new Error('distribution must be linear, exponential, or flat');

  const client = opts.client ?? getClient();
  if (opts.verbose) client.verbose = true;

  out('Open Broker - Scale In/Out');
  out('==========================\n');

  const mids = await client.getAllMids();
  const midPrice = parseFloat(mids[opts.coin]);
  if (!midPrice) throw new Error(`No market data for ${opts.coin}`);

  const levels = calculateLevels(midPrice, isBuy, opts.size, opts.levels, opts.rangePct, distribution);
  const notional = levels.reduce((sum, l) => sum + l.price * l.size, 0);
  const avgPrice = notional / opts.size;

  out('Order Plan');
  out('----------');
  out(`Coin:           ${opts.coin}`);
  out(`Side:           ${isBuy ? 'BUY' : 'SELL'}`);
  out(`Total Size:     ${opts.size}`);
  out(`Current Mid:    ${formatUsd(midPrice)}`);
  out(`Levels:         ${opts.levels}`);
  out(`Range:          ${opts.rangePct}% ${isBuy ? 'below' : 'above'} mid`);
  out(`Distribution:   ${distribution}`);
  out(`Time in Force:  ${tif}`);
  out(`Reduce Only:    ${reduceOnly ? 'Yes' : 'No'}`);
  out(`Est. Notional:  ${formatUsd(notional)}`);
  out(`Avg Price:      ${formatUsd(avgPrice)}`);

  out('\nOrder Grid');
  out('----------');
  out('Level | Price        | Size       | Distance');
  out('------|--------------|------------|----------');

  for (const level of levels) {
    out(
      `  ${level.level.toString().padStart(2)}  | ` +
      `${formatUsd(level.price).padStart(12)} | ` +
      `${level.size.toFixed(6).padStart(10)} | ` +
      `${level.distanceFromMid.toFixed(2)}%`
    );
  }

  if (opts.dryRun) {
    out('\n🔍 Dry run - orders not placed');
    return { status: 'dry', levels, restingOids: [], filledOids: [], errors: [], rolledBack: false };
  }

  out('\nPlacing ladder as a bulk order...\n');

  const response = await client.bulkOrder(
    levels.map((level) => ({
      coin: opts.coin,
      isBuy,
      size: level.size,
      price: level.price,
      tif,
      reduceOnly,
      leverage: opts.leverage,
    }))
  );

  const restingOids: number[] = [];
  const filledOids: number[] = [];
  const errors: string[] = [];

  if (response.status === 'ok' && response.response && typeof response.response === 'object') {
    response.response.data.statuses.forEach((status, index) => {
      const level = levels[index];
      if (status?.resting) {
        restingOids.push(status.resting.oid);
        out(`Level ${level.level}: ✅ OID ${status.resting.oid}`);
      } else if (status?.filled) {
        filledOids.push(status.filled.oid);
        out(`Level ${level.level}: ✅ Filled ${status.filled.totalSz} @ ${formatUsd(parseFloat(status.filled.avgPx))}`);
      } else if (status?.error) {
        errors.push(`Level ${level.level}: ${status.error}`);
        out(`Level ${level.level}: ❌ ${status.error}`);
      } else {
        errors.push(`Level ${level.level}: Unknown status`);
        out(`Level ${level.level}: ⚠️ Unknown status`);
      }
    });
  } else {
    const reason = typeof response.response === 'string' ? response.response : 'Bulk order failed';
    errors.push(reason);
    out(`❌ ${reason}`);
  }

  let rolledBack = false;
  if (errors.length > 0 && rollbackOnPartial && restingOids.length > 0) {
    out('\nPartial ladder placement detected; cancelling resting ladder orders...');
    await client.bulkCancel(restingOids.map((oid) => ({ coin: opts.coin, oid })));
    rolledBack = true;
    out(`Cancelled ${restingOids.length} resting order(s).`);
  }

  out('\n========== Summary ==========');
  out(`Orders Placed:  ${restingOids.length + filledOids.length}/${opts.levels}`);
  if (errors.length > 0) out(`Failed:         ${errors.length}`);
  if (restingOids.length > 0) out(`Resting OIDs:   ${restingOids.join(', ')}`);
  if (filledOids.length > 0) out(`Filled OIDs:    ${filledOids.join(', ')}`);
  if (rolledBack) out('Rollback:       Resting orders cancelled');

  const status = errors.length === 0
    ? 'complete'
    : restingOids.length + filledOids.length > 0
      ? 'partial'
      : 'failed';

  return { status, levels, restingOids, filledOids, errors, rolledBack };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const coin = args.coin as string;
  const side = args.side as string;
  const totalSize = parseFloat(args.size as string);
  const numLevels = parseInt(args.levels as string);
  const rangePct = parseFloat(args.range as string);
  const distribution = (args.distribution as string || 'linear') as 'linear' | 'exponential' | 'flat';
  const leverage = args.leverage ? parseInt(args.leverage as string) : undefined;
  const reduceOnly = args.reduce as boolean;
  const tifArg = ((args.tif as string)?.toUpperCase() || 'GTC');
  const dryRun = args.dry as boolean;

  if (!coin || !side || isNaN(totalSize) || isNaN(numLevels) || isNaN(rangePct)) {
    printUsage();
    process.exit(1);
  }

  const tifMap: Record<string, 'Gtc' | 'Alo'> = {
    'GTC': 'Gtc',
    'ALO': 'Alo'
  };

  const tif = tifMap[tifArg];
  if (!tif) {
    console.error('Error: --tif must be GTC or ALO');
    process.exit(1);
  }

  try {
    const result = await runScale({
      coin,
      side: side as 'buy' | 'sell',
      size: totalSize,
      levels: numLevels,
      rangePct,
      distribution,
      leverage,
      reduceOnly,
      tif,
      dryRun,
      verbose: args.verbose as boolean,
    });
    if (result.status === 'failed') process.exit(1);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

// Only run when invoked as a script — not when imported as a module.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
