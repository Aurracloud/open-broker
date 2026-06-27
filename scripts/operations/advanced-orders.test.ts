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

test('bracket waits for limit-entry fill and arms linked TP/SL for confirmed size', async () => {
  const pairCalls: Array<{ size: number; tp: number; sl: number; isBuy: boolean }> = [];
  const client: BracketClient = {
    verbose: false,
    address: '0x0000000000000000000000000000000000000001',
    async getAllMids() {
      return { ETH: '1000' };
    },
    async marketOrder() {
      throw new Error('marketOrder should not be called');
    },
    async limitOrder() {
      return okOrder([{ resting: { oid: 777 } }]);
    },
    async tpslPair(_coin, isBuy, size, tp, sl) {
      pairCalls.push({ size, tp, sl, isBuy });
      return okOrder([{ resting: { oid: 778 } }, { resting: { oid: 779 } }]);
    },
    async getUserFills() {
      return [];
    },
  };

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
  assert.equal(pairCalls[0].tp, 1029);
  assert.equal(pairCalls[0].sl, 960.4);
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
