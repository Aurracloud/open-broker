import assert from 'node:assert/strict';
import test from 'node:test';
import type { HyperliquidClient } from '../core/client.js';
import {
  CLIENT_WRITE_METHODS,
  GuardrailViolation,
  createGuardrailedClient,
  validateAutomationGuardrails,
} from './guardrails.js';
import { listExamples, loadAutomation } from './loader.js';
import type { AutomationLogger, TradingAutomationGuardrails } from './types.js';

const logger: AutomationLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

function tradingPolicy(overrides: Partial<TradingAutomationGuardrails> = {}): TradingAutomationGuardrails {
  return {
    mode: 'trading',
    allowedMarkets: ['ETH'],
    maxOrderUsd: 1_000,
    maxPositionUsd: 2_000,
    maxTotalExposureUsd: 5_000,
    maxLeverage: 2,
    maxMarginUsedPct: 50,
    maxOpenOrders: 10,
    maxOrdersPerMinute: 10,
    maxSlippageBps: 40,
    allowMarketOrders: true,
    allowAccountWideCancel: false,
    ...overrides,
  };
}

function mockClient(options: {
  positions?: Array<{ coin: string; size: number; price: number; leverage?: number }>;
} = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client = {
    address: '0x0000000000000000000000000000000000000001',
    walletAddress: '0x0000000000000000000000000000000000000002',
    isApiWallet: true,
    async getUserStateAll() {
      return {
        assetPositions: (options.positions ?? []).map((position) => ({
          position: {
            coin: position.coin,
            szi: String(position.size),
            positionValue: String(Math.abs(position.size * position.price)),
            leverage: { type: 'cross', value: position.leverage ?? 1 },
          },
        })),
        marginSummary: { accountValue: '10000', totalMarginUsed: '0' },
      };
    },
    async getAllMids() { return { ETH: '2000', BTC: '50000' }; },
    async getOpenOrders() { return []; },
    async getSpotBalances() { return { balances: [] }; },
    async getSpotMetaAndAssetCtxs() {
      return { meta: { tokens: [], universe: [] }, assetCtxs: [] };
    },
    resolveOutcomeRef() {
      return { outcome: 1, side: 0, encoding: 10, coin: '#10', tokenName: '+10', assetId: 100000010 };
    },
    async marketOrder(...args: unknown[]) {
      calls.push({ method: 'marketOrder', args });
      return { status: 'ok' };
    },
    async limitOrder(...args: unknown[]) {
      calls.push({ method: 'limitOrder', args });
      return { status: 'ok' };
    },
    async bulkOrder(...args: unknown[]) {
      calls.push({ method: 'bulkOrder', args });
      return { status: 'ok' };
    },
  } as unknown as HyperliquidClient;
  return { client, calls };
}

test('guardrail schema rejects missing and internally inconsistent limits', () => {
  assert.throws(
    () => validateAutomationGuardrails({ mode: 'trading' }),
    /allowedMarkets/,
  );
  assert.throws(
    () => validateAutomationGuardrails(tradingPolicy({ maxOrderUsd: 3_000 })),
    /maxOrderUsd.*maxPositionUsd/,
  );
  assert.deepEqual(validateAutomationGuardrails({ mode: 'read-only' }), { mode: 'read-only' });
});

test('all client write families are included in the enforcement boundary', () => {
  for (const method of [
    'bulkOrder', 'bulkCancel', 'scheduleCancel',
    'outcomeOrder', 'outcomeMarketOrder', 'outcomeLimitOrder',
  ]) {
    assert.equal(CLIENT_WRITE_METHODS.has(method), true, `${method} must be guarded`);
  }
});

test('every bundled example exports a valid guardrail policy', async () => {
  for (const example of listExamples()) {
    const loaded = await loadAutomation(example.path, { config: {} });
    assert.ok(loaded.guardrails.mode === 'read-only' || loaded.guardrails.mode === 'trading');
  }
});

test('read-only policy blocks every write before it reaches the client', async () => {
  const { client, calls } = mockClient();
  const guarded = createGuardrailedClient(client, {
    policy: { mode: 'read-only' },
    rawClient: client,
    log: logger,
  });

  await assert.rejects(
    guarded.bulkOrder([{ coin: 'ETH', isBuy: true, size: 0.1, price: 2000 }]),
    (error: unknown) => error instanceof GuardrailViolation && error.code === 'read-only',
  );
  assert.equal(calls.length, 0);
});

test('trading policy blocks disallowed markets, missing leverage, and oversized orders', async () => {
  const { client, calls } = mockClient();
  const guarded = createGuardrailedClient(client, {
    policy: tradingPolicy(),
    rawClient: client,
    log: logger,
  });

  await assert.rejects(
    guarded.limitOrder('BTC', true, 0.01, 50_000, 'Gtc', false, 1),
    (error: unknown) => error instanceof GuardrailViolation && error.code === 'market-not-allowed',
  );
  await assert.rejects(
    guarded.limitOrder('ETH', true, 0.1, 2_000),
    (error: unknown) => error instanceof GuardrailViolation && error.code === 'leverage-required',
  );
  await assert.rejects(
    guarded.limitOrder('ETH', true, 0.6, 2_000, 'Gtc', false, 1),
    (error: unknown) => error instanceof GuardrailViolation && error.code === 'order-notional',
  );
  assert.equal(calls.length, 0);
});

test('valid market orders execute with runtime-capped slippage', async () => {
  const { client, calls } = mockClient();
  const guarded = createGuardrailedClient(client, {
    policy: tradingPolicy(),
    rawClient: client,
    log: logger,
  });

  await guarded.marketOrder('ETH', true, 0.1, undefined, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    method: 'marketOrder',
    args: ['ETH', true, 0.1, 40, 1],
  });
});

test('account-wide exposure is checked while genuine reductions remain available above caps', async () => {
  const exposed = mockClient({ positions: [{ coin: 'BTC', size: 0.1, price: 50_000 }] });
  const exposureGuarded = createGuardrailedClient(exposed.client, {
    policy: tradingPolicy({ maxTotalExposureUsd: 5_100 }),
    rawClient: exposed.client,
    log: logger,
  });
  await assert.rejects(
    exposureGuarded.limitOrder('ETH', true, 0.1, 2_000, 'Gtc', false, 1),
    (error: unknown) => error instanceof GuardrailViolation && error.code === 'total-exposure',
  );

  const reducing = mockClient({ positions: [{ coin: 'ETH', size: 1, price: 2_000 }] });
  const reductionGuarded = createGuardrailedClient(reducing.client, {
    policy: tradingPolicy({ maxPositionUsd: 1_000, maxTotalExposureUsd: 1_000 }),
    rawClient: reducing.client,
    log: logger,
  });
  await reductionGuarded.marketOrder('ETH', false, 0.1);
  assert.equal(reducing.calls.length, 1);
});
