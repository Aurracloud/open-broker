import test from 'node:test';
import assert from 'node:assert/strict';
import { runBracket, type BracketClient } from './bracket.js';
import { runChase, type ChaseClient } from './chase.js';
import { runScale, type ScaleClient } from './scale.js';
import { UserFillWatcher, type FillSummary, type FillWatcher } from './execution.js';
import type { CancelResponse, OpenOrder, OrderResponse } from '../core/types.js';

const okOrder = (statuses: OrderResponse['response'] extends infer R
  ? R extends { data: { statuses: infer S } } ? S : never
  : never): OrderResponse => ({
    status: 'ok',
    response: { type: 'order', data: { statuses } },
  });

const okCancel = (): CancelResponse => ({
  status: 'ok',
  response: { type: 'cancel', data: { statuses: ['success'] } },
});

class StaticFillWatcher implements FillWatcher {
  constructor(private readonly fills: Map<number, FillSummary>) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getFilled(oid: number): FillSummary {
    return this.fills.get(oid) ?? { size: 0, notional: 0 };
  }
  async waitForFill(oid: number): Promise<FillSummary> {
    return this.getFilled(oid);
  }
}

function bracketClientStub(overrides: Partial<BracketClient> = {}): BracketClient {
  return {
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getAllMids() {
      return { ETH: '1000' };
    },
    async marketOrder() {
      throw new Error('marketOrder should not be called');
    },
    async limitOrder() {
      throw new Error('limitOrder should not be called');
    },
    async tpslOrders() {
      throw new Error('tpslOrders should not be called');
    },
    async bracketOrder() {
      throw new Error('bracketOrder should not be called');
    },
    async cancel() {
      throw new Error('cancel should not be called');
    },
    async getUserFills() {
      return [];
    },
    ...overrides,
  };
}

test('scale rejects invalid levels and rolls back resting orders on partial ladder placement', async () => {
  const cancelled: Array<{ coin: string; oid: number }> = [];
  const client: ScaleClient = {
    verbose: false,
    async getAllMids() {
      return { ETH: '1000' };
    },
    async bulkOrder() {
      return okOrder([
        { resting: { oid: 101 } },
        { error: 'insufficient margin' },
        { resting: { oid: 103 } },
      ]);
    },
    async bulkCancel(cancels) {
      cancelled.push(...cancels);
      return okCancel();
    },
  };

  await assert.rejects(
    () => runScale({
      coin: 'ETH',
      side: 'buy',
      size: 1,
      levels: 0,
      rangePct: 2,
      client,
      output: () => {},
    }),
    /levels must be a positive integer/,
  );

  const result = await runScale({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    levels: 3,
    rangePct: 2,
    client,
    output: () => {},
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.rolledBack, true);
  assert.deepEqual(cancelled, [
    { coin: 'ETH', oid: 101 },
    { coin: 'ETH', oid: 103 },
  ]);
});

test('scale pre-checks the $10 exchange minimum on the thinnest level (waived for reduce-only)', async () => {
  let placed = false;
  const client: ScaleClient = {
    verbose: false,
    async getAllMids() {
      return { ETH: '1000' };
    },
    async bulkOrder(orders) {
      placed = true;
      return okOrder(orders.map((_, i) => ({ resting: { oid: 200 + i } })));
    },
    async bulkCancel() {
      return okCancel();
    },
  };

  // Total ~$30 over 3 linear levels → thinnest level ~$5 < $10.
  await assert.rejects(
    () => runScale({
      coin: 'ETH',
      side: 'buy',
      size: 0.03,
      levels: 3,
      rangePct: 2,
      client,
      output: () => {},
    }),
    /below the \$10 exchange minimum/,
  );
  assert.equal(placed, false);

  // Same ladder reduce-only is allowed (exchange waives the minimum).
  const result = await runScale({
    coin: 'ETH',
    side: 'buy',
    size: 0.03,
    levels: 3,
    rangePct: 2,
    reduceOnly: true,
    client,
    output: () => {},
  });
  assert.equal(result.status, 'complete');
});

test('bracket limit entry defaults to one atomic normalTpsl batch', async () => {
  const calls: Array<{ coin: string; isBuy: boolean; size: number; entryPrice: number; opts: Record<string, unknown> }> = [];
  const client = bracketClientStub({
    async bracketOrder(coin, isBuy, size, entryPrice, opts) {
      calls.push({ coin, isBuy, size, entryPrice, opts: opts ?? {} });
      return okOrder([
        { resting: { oid: 500 } },
        'waitingForFill' as never,
        'waitingForFill' as never,
      ]);
    },
  });

  const result = await runBracket({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    tpPct: 5,
    slPct: 2,
    entryType: 'limit',
    entryPrice: 990,
    client,
    output: () => {},
  });

  assert.equal(result.status, 'armed');
  assert.equal(result.entryOid, 500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isBuy, true);
  assert.equal(calls[0].entryPrice, 990);
  assert.equal(calls[0].opts.takeProfitPrice, 990 * 1.05);
  assert.equal(calls[0].opts.stopLossPrice, 990 * 0.98);
  assert.equal(calls[0].opts.stopLossIsMarket, true);
});

test('bracket atomic batch rolls back resting orders when a leg is rejected', async () => {
  const cancelled: number[] = [];
  const client = bracketClientStub({
    async bracketOrder() {
      return okOrder([
        { resting: { oid: 600 } },
        'waitingForFill' as never,
        { error: 'Invalid TP/SL price.' },
      ]);
    },
    async cancel(_coin, oid) {
      cancelled.push(oid);
      return okCancel();
    },
  });

  const result = await runBracket({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    tpPct: 5,
    slPct: 2,
    entryType: 'limit',
    entryPrice: 990,
    client,
    output: () => {},
  });

  assert.equal(result.status, 'entry_failed');
  assert.match(result.reason ?? '', /Invalid TP\/SL price/);
  assert.deepEqual(cancelled, [600]);
});

test('bracket with --no-atomic waits for limit-entry fill and arms positionTpsl for confirmed size', async () => {
  const pairCalls: Array<{ size: number; isBuy: boolean; opts: Record<string, unknown> }> = [];
  const client = bracketClientStub({
    async limitOrder() {
      return okOrder([{ resting: { oid: 777 } }]);
    },
    async tpslOrders(_coin, isBuy, size, opts) {
      pairCalls.push({ size, isBuy, opts: opts ?? {} });
      return okOrder([{ resting: { oid: 778 } }, { resting: { oid: 779 } }]);
    },
  });

  const fillWatcher = new StaticFillWatcher(new Map([
    [777, { size: 0.4, notional: 392, avgPrice: 980 }],
  ]));

  const result = await runBracket({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    tpPct: 5,
    slPct: 2,
    entryType: 'limit',
    entryPrice: 990,
    entryTimeoutSec: 5,
    atomic: false,
    client,
    fillWatcher,
    output: () => {},
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.protectedSize, 0.4);
  assert.equal(result.entryPrice, 980);
  assert.equal(pairCalls.length, 1);
  assert.equal(pairCalls[0].size, 0.4);
  assert.equal(pairCalls[0].isBuy, false);
  assert.equal(pairCalls[0].opts.grouping, 'positionTpsl');
  assert.equal(pairCalls[0].opts.takeProfitPrice, 1029);
  assert.equal(pairCalls[0].opts.stopLossPrice, 960.4);
});

test('bracket market entry supports a one-sided TP sized to the actual fill', async () => {
  const calls: Array<{ isBuy: boolean; size: number; opts: Record<string, unknown> }> = [];
  const client = bracketClientStub({
    async marketOrder() {
      return okOrder([{ filled: { totalSz: '0.8', avgPx: '1001', oid: 1 } }]);
    },
    async tpslOrders(_coin, isBuy, size, opts) {
      calls.push({ isBuy, size, opts: opts ?? {} });
      return okOrder([{ resting: { oid: 2 } }]);
    },
  });

  const result = await runBracket({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    tpPct: 5,
    entryType: 'market',
    client,
    fillWatcher: new StaticFillWatcher(new Map()),
    output: () => {},
  });

  assert.equal(result.status, 'complete');
  assert.equal(result.protectedSize, 0.8);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].size, 0.8);
  assert.equal(calls[0].isBuy, false);
  assert.equal(calls[0].opts.grouping, 'positionTpsl');
  assert.equal(calls[0].opts.takeProfitPrice, 1001 * 1.05);
  assert.equal(calls[0].opts.stopLossPrice, undefined);
});

test('bracket validates targets before any order goes out', async () => {
  // SL% ≥ 100 resolves to a negative price.
  await assert.rejects(
    () => runBracket({
      coin: 'ETH',
      side: 'buy',
      size: 1,
      tpPct: 5,
      slPct: 150,
      client: bracketClientStub(),
      output: () => {},
    }),
    /SL must resolve to a positive price/,
  );

  // Absolute TP on the wrong side of the entry.
  await assert.rejects(
    () => runBracket({
      coin: 'ETH',
      side: 'buy',
      size: 1,
      tpPrice: 900,
      entryType: 'limit',
      entryPrice: 990,
      client: bracketClientStub(),
      output: () => {},
    }),
    /TP price must be above entry/,
  );

  // No target at all.
  await assert.rejects(
    () => runBracket({
      coin: 'ETH',
      side: 'buy',
      size: 1,
      client: bracketClientStub(),
      output: () => {},
    }),
    /provide a TP target, an SL target, or both/,
  );
});

test('chase requotes only the remaining size after a partial fill', async () => {
  const limitSizes: number[] = [];
  const cancelled: number[] = [];
  const fills = new Map<number, FillSummary>();
  let orderCount = 0;
  let mid = 1000;

  const client: ChaseClient = {
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getAllMids() {
      mid += 2;
      return { ETH: String(mid) };
    },
    async getOpenOrders(): Promise<OpenOrder[]> {
      return [];
    },
    async getUserFills() {
      return [];
    },
    async limitOrder(_coin, _isBuy, size) {
      limitSizes.push(size);
      orderCount += 1;
      const oid = 900 + orderCount;
      if (orderCount === 1) {
        fills.set(oid, { size: 0.4, notional: 400, avgPrice: 1000 });
      } else {
        fills.set(oid, { size, notional: size * 1002, avgPrice: 1002 });
      }
      return okOrder([{ resting: { oid } }]);
    },
    async cancel(_coin, oid) {
      cancelled.push(oid);
      return okCancel();
    },
  };

  const result = await runChase({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    offsetBps: 5,
    timeoutSec: 2,
    intervalMs: 1,
    maxChaseBps: 1_000,
    client,
    fillWatcher: new StaticFillWatcher(fills),
    output: () => {},
  });

  assert.equal(result.status, 'filled');
  assert.equal(limitSizes.length, 2);
  assert.equal(limitSizes[0], 1);
  assert(Math.abs(limitSizes[1] - 0.6) < 1e-9);
  assert.deepEqual(cancelled, [901]);
});

test('chase reprices and continues after a post-only rejection', async () => {
  const fills = new Map<number, FillSummary>();
  let orderCount = 0;

  const client: ChaseClient = {
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getAllMids() {
      return { ETH: '1000' };
    },
    async getOpenOrders(): Promise<OpenOrder[]> {
      return [];
    },
    async getUserFills() {
      return [];
    },
    async limitOrder(_coin, _isBuy, size) {
      orderCount += 1;
      if (orderCount === 1) {
        return okOrder([{ error: 'Post only order would have immediately matched, bbo was 999.9@1000.1' }]);
      }
      const oid = 900 + orderCount;
      fills.set(oid, { size, notional: size * 1000, avgPrice: 1000 });
      return okOrder([{ resting: { oid } }]);
    },
    async cancel() {
      return okCancel();
    },
  };

  const result = await runChase({
    coin: 'ETH',
    side: 'buy',
    size: 1,
    offsetBps: 5,
    timeoutSec: 2,
    intervalMs: 1,
    maxChaseBps: 1_000,
    client,
    fillWatcher: new StaticFillWatcher(fills),
    output: () => {},
  });

  assert.equal(result.status, 'filled');
  assert.equal(orderCount, 2);
});

test('chase cancels the resting order even when the loop throws', async () => {
  const cancelled: number[] = [];

  const client: ChaseClient = {
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getAllMids() {
      return { ETH: '1000' };
    },
    async getOpenOrders(): Promise<OpenOrder[]> {
      throw new Error('open-orders lookup exploded');
    },
    async getUserFills() {
      return [];
    },
    async limitOrder() {
      return okOrder([{ resting: { oid: 950 } }]);
    },
    async cancel(_coin, oid) {
      cancelled.push(oid);
      return okCancel();
    },
  };

  await assert.rejects(
    () => runChase({
      coin: 'ETH',
      side: 'buy',
      size: 1,
      offsetBps: 5,
      timeoutSec: 2,
      intervalMs: 1,
      maxChaseBps: 1_000,
      client,
      fillWatcher: new StaticFillWatcher(new Map()),
      output: () => {},
    }),
    /open-orders lookup exploded/,
  );

  assert.deepEqual(cancelled, [950]);
});

test('chase rejects a start size below the $10 exchange minimum', async () => {
  const client: ChaseClient = {
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getAllMids() {
      return { ETH: '1000' };
    },
    async getOpenOrders(): Promise<OpenOrder[]> {
      return [];
    },
    async getUserFills() {
      return [];
    },
    async limitOrder() {
      throw new Error('limitOrder should not be called');
    },
    async cancel() {
      return okCancel();
    },
  };

  await assert.rejects(
    () => runChase({
      coin: 'ETH',
      side: 'buy',
      size: 0.005,
      client,
      fillWatcher: new StaticFillWatcher(new Map()),
      output: () => {},
    }),
    /below the \$10 exchange minimum/,
  );
});

test('user fill watcher de-duplicates repeated REST fallback fills', async () => {
  const fillTime = Date.now();
  const watcher = new UserFillWatcher({
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getUserFills() {
      return [
        { coin: 'ETH', px: '1000', sz: '0.25', time: fillTime, oid: 123 },
      ];
    },
  }, { ws: null, sinceMs: fillTime - 1000 });

  await watcher.start();
  await watcher.waitForFill(123, 1, 1, { coin: 'ETH', pollMs: 1 });
  await watcher.waitForFill(123, 1, 1, { coin: 'ETH', pollMs: 1 });

  assert.equal(watcher.getFilled(123).size, 0.25);
});
