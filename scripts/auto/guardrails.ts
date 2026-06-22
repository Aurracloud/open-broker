// Automation guardrail schema validation and runtime enforcement.

import type { HyperliquidClient } from '../core/client.js';
import { normalizeCoin } from '../core/utils.js';
import type {
  AutomationGuardrailContext,
  AutomationGuardrails,
  AutomationGuardrailsExport,
  AutomationLogger,
  TradingAutomationGuardrails,
} from './types.js';

export const CLIENT_WRITE_METHODS = new Set([
  'order', 'bulkOrder', 'marketOrder', 'limitOrder', 'triggerOrder',
  'takeProfit', 'stopLoss',
  'cancel', 'bulkCancel', 'cancelAll', 'scheduleCancel',
  'spotOrder', 'spotMarketOrder', 'spotLimitOrder', 'spotCancel',
  'outcomeOrder', 'outcomeMarketOrder', 'outcomeLimitOrder',
  'updateLeverage', 'approveBuilderFee',
  'twapOrder', 'twapCancel',
]);

const TRADING_KEYS = new Set([
  'mode',
  'allowedMarkets',
  'maxOrderUsd',
  'maxPositionUsd',
  'maxTotalExposureUsd',
  'maxLeverage',
  'maxMarginUsedPct',
  'maxOpenOrders',
  'maxOrdersPerMinute',
  'maxSlippageBps',
  'allowMarketOrders',
  'allowAccountWideCancel',
]);

export class GuardrailViolation extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`[guardrail:${code}] ${message}`);
    this.name = 'GuardrailViolation';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaError(message: string): never {
  throw new Error(`Invalid automation guardrails: ${message}`);
}

function requirePositiveNumber(
  value: unknown,
  field: keyof TradingAutomationGuardrails,
  opts: { integer?: boolean; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    schemaError(`"${field}" must be a finite number greater than 0`);
  }
  if (opts.integer && !Number.isInteger(value)) {
    schemaError(`"${field}" must be an integer`);
  }
  if (opts.max !== undefined && value > opts.max) {
    schemaError(`"${field}" must be less than or equal to ${opts.max}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: keyof TradingAutomationGuardrails): boolean {
  if (typeof value !== 'boolean') schemaError(`"${field}" must be a boolean`);
  return value;
}

export function canonicalMarket(market: string): string {
  const trimmed = market.trim();
  if (trimmed.startsWith('spot:')) {
    return `spot:${trimmed.slice(5).toUpperCase()}`;
  }
  if (trimmed.startsWith('#')) return trimmed;
  return normalizeCoin(trimmed);
}

export function validateAutomationGuardrails(value: unknown): AutomationGuardrails {
  if (!isPlainObject(value)) schemaError('export must be an object');

  if (value.mode === 'read-only') {
    const unknown = Object.keys(value).filter((key) => key !== 'mode');
    if (unknown.length > 0) {
      schemaError(`read-only mode has unknown field(s): ${unknown.join(', ')}`);
    }
    return { mode: 'read-only' };
  }

  if (value.mode !== 'trading') {
    schemaError('"mode" must be either "read-only" or "trading"');
  }

  const unknown = Object.keys(value).filter((key) => !TRADING_KEYS.has(key));
  if (unknown.length > 0) schemaError(`unknown field(s): ${unknown.join(', ')}`);

  if (!Array.isArray(value.allowedMarkets) || value.allowedMarkets.length === 0) {
    schemaError('"allowedMarkets" must be a non-empty array');
  }
  const allowedMarkets = value.allowedMarkets.map((market, index) => {
    if (typeof market !== 'string' || market.trim() === '') {
      schemaError(`"allowedMarkets[${index}]" must be a non-empty string`);
    }
    if (market === '*') schemaError('wildcard markets are not allowed');
    return canonicalMarket(market);
  });
  if (new Set(allowedMarkets).size !== allowedMarkets.length) {
    schemaError('"allowedMarkets" contains duplicates after normalization');
  }

  const guardrails: TradingAutomationGuardrails = {
    mode: 'trading',
    allowedMarkets,
    maxOrderUsd: requirePositiveNumber(value.maxOrderUsd, 'maxOrderUsd'),
    maxPositionUsd: requirePositiveNumber(value.maxPositionUsd, 'maxPositionUsd'),
    maxTotalExposureUsd: requirePositiveNumber(value.maxTotalExposureUsd, 'maxTotalExposureUsd'),
    maxLeverage: requirePositiveNumber(value.maxLeverage, 'maxLeverage', { integer: true, max: 100 }),
    maxMarginUsedPct: requirePositiveNumber(value.maxMarginUsedPct, 'maxMarginUsedPct', { max: 100 }),
    maxOpenOrders: requirePositiveNumber(value.maxOpenOrders, 'maxOpenOrders', { integer: true }),
    maxOrdersPerMinute: requirePositiveNumber(value.maxOrdersPerMinute, 'maxOrdersPerMinute', { integer: true }),
    maxSlippageBps: requirePositiveNumber(value.maxSlippageBps, 'maxSlippageBps', { integer: true, max: 10_000 }),
    allowMarketOrders: requireBoolean(value.allowMarketOrders, 'allowMarketOrders'),
    allowAccountWideCancel: requireBoolean(value.allowAccountWideCancel, 'allowAccountWideCancel'),
  };

  if (guardrails.maxOrderUsd > guardrails.maxPositionUsd) {
    schemaError('"maxOrderUsd" cannot exceed "maxPositionUsd"');
  }
  if (guardrails.maxPositionUsd > guardrails.maxTotalExposureUsd) {
    schemaError('"maxPositionUsd" cannot exceed "maxTotalExposureUsd"');
  }

  return guardrails;
}

export function resolveAutomationGuardrails(
  exported: AutomationGuardrailsExport,
  context: AutomationGuardrailContext,
): AutomationGuardrails {
  let value: unknown;
  try {
    value = typeof exported === 'function' ? exported(context) : exported;
  } catch (error) {
    throw new Error(
      `Automation guardrails factory failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateAutomationGuardrails(value);
}

interface Holding {
  quantity: number;
  price: number;
  leverage?: number;
  kind: 'perp' | 'spot' | 'outcome';
}

interface RiskSnapshot {
  holdings: Map<string, Holding>;
  equity: number;
  marginUsed: number;
  openOrders: number;
  prices: Map<string, number>;
  loadedAt: number;
}

interface ProposedOrder {
  market: string;
  kind: Holding['kind'];
  isBuy: boolean;
  size: number;
  price?: number;
  reduceOnly: boolean;
  leverage?: number;
  contingent?: boolean;
  resting: boolean;
  slippageBps?: number;
}

function finitePositive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GuardrailViolation('invalid-order', `${label} must be a finite number greater than 0`);
  }
  return value;
}

function canonicalSpotMarket(coin: unknown): string {
  if (typeof coin !== 'string' || coin.trim() === '') {
    throw new GuardrailViolation('invalid-market', 'spot market must be a non-empty string');
  }
  return canonicalMarket(`spot:${coin}`);
}

function canonicalPerpMarket(coin: unknown): string {
  if (typeof coin !== 'string' || coin.trim() === '') {
    throw new GuardrailViolation('invalid-market', 'perp market must be a non-empty string');
  }
  return canonicalMarket(coin);
}

function marketKind(market: string): Holding['kind'] {
  if (market.startsWith('spot:')) return 'spot';
  if (market.startsWith('#')) return 'outcome';
  return 'perp';
}

function assertAllowedMarket(policy: TradingAutomationGuardrails, market: string): void {
  if (!policy.allowedMarkets.includes(market)) {
    throw new GuardrailViolation(
      'market-not-allowed',
      `${market} is not in allowedMarkets (${policy.allowedMarkets.join(', ')})`,
    );
  }
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function orderSide(value: unknown, label = 'isBuy'): boolean {
  if (typeof value !== 'boolean') {
    throw new GuardrailViolation('invalid-order', `${label} must be a boolean`);
  }
  return value;
}

function isRestingOrderType(value: unknown): boolean {
  if (!isPlainObject(value) || !isPlainObject(value.limit)) return true;
  return value.limit.tif !== 'Ioc';
}

function isRestingTif(value: unknown, fallback: 'Gtc' | 'Ioc' | 'Alo' = 'Gtc'): boolean {
  return (value ?? fallback) !== 'Ioc';
}

function prepareMarketOrderArgs(
  method: string,
  args: unknown[],
  policy: TradingAutomationGuardrails,
): unknown[] {
  const next = [...args];
  const slippageIndex = method === 'outcomeMarketOrder' ? 4 : 3;
  const requested = next[slippageIndex];
  if (requested === undefined) {
    next[slippageIndex] = policy.maxSlippageBps;
  } else {
    const slippage = finitePositive(requested, 'slippageBps');
    if (slippage > policy.maxSlippageBps) {
      throw new GuardrailViolation(
        'slippage-limit',
        `requested ${slippage} bps exceeds maxSlippageBps ${policy.maxSlippageBps}`,
      );
    }
  }
  return next;
}

function proposedOrders(
  method: string,
  args: unknown[],
  rawClient: HyperliquidClient,
): ProposedOrder[] {
  switch (method) {
    case 'order':
      return [{
        market: canonicalPerpMarket(args[0]), kind: 'perp', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), price: finitePositive(args[3], 'price'),
        reduceOnly: asBoolean(args[5]), leverage: args[7] as number | undefined,
        resting: isRestingOrderType(args[4]),
      }];
    case 'bulkOrder': {
      if (!Array.isArray(args[0]) || args[0].length === 0) {
        throw new GuardrailViolation('invalid-order', 'bulkOrder requires at least one order');
      }
      return args[0].map((value, index) => {
        if (!isPlainObject(value)) throw new GuardrailViolation('invalid-order', `bulkOrder[${index}] must be an object`);
        return {
          market: canonicalPerpMarket(value.coin), kind: 'perp', isBuy: orderSide(value.isBuy, `bulkOrder[${index}].isBuy`),
          size: finitePositive(value.size, `bulkOrder[${index}].size`),
          price: finitePositive(value.price, `bulkOrder[${index}].price`),
          reduceOnly: asBoolean(value.reduceOnly), leverage: value.leverage as number | undefined,
          resting: isRestingTif(value.tif),
        };
      });
    }
    case 'marketOrder':
      return [{
        market: canonicalPerpMarket(args[0]), kind: 'perp', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), reduceOnly: false, leverage: args[4] as number | undefined,
        resting: false, slippageBps: args[3] as number,
      }];
    case 'limitOrder':
      return [{
        market: canonicalPerpMarket(args[0]), kind: 'perp', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), price: finitePositive(args[3], 'price'),
        reduceOnly: asBoolean(args[5]), leverage: args[6] as number | undefined,
        resting: isRestingTif(args[4]),
      }];
    case 'triggerOrder':
      return [{
        market: canonicalPerpMarket(args[0]), kind: 'perp', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), price: finitePositive(args[4], 'limitPrice'),
        reduceOnly: args[6] === undefined ? true : asBoolean(args[6]), leverage: args[7] as number | undefined,
        contingent: true,
        resting: true,
      }];
    case 'stopLoss':
    case 'takeProfit':
      return [{
        market: canonicalPerpMarket(args[0]), kind: 'perp', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), price: finitePositive(args[3], 'triggerPrice'),
        reduceOnly: true, contingent: true, resting: true,
      }];
    case 'spotOrder':
      return [{
        market: canonicalSpotMarket(args[0]), kind: 'spot', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), price: finitePositive(args[3], 'price'), reduceOnly: false,
        resting: isRestingOrderType(args[4]),
      }];
    case 'spotMarketOrder':
      return [{
        market: canonicalSpotMarket(args[0]), kind: 'spot', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), reduceOnly: false,
        resting: false, slippageBps: args[3] as number,
      }];
    case 'spotLimitOrder':
      return [{
        market: canonicalSpotMarket(args[0]), kind: 'spot', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), price: finitePositive(args[3], 'price'), reduceOnly: false,
        resting: isRestingTif(args[4]),
      }];
    case 'outcomeOrder':
    case 'outcomeLimitOrder': {
      const resolved = rawClient.resolveOutcomeRef(args[0] as string | number, args[1] as string | number | undefined);
      return [{
        market: canonicalMarket(resolved.coin), kind: 'outcome', isBuy: orderSide(args[2]),
        size: finitePositive(args[3], 'size'), price: finitePositive(args[4], 'price'), reduceOnly: false,
        resting: method === 'outcomeOrder' ? isRestingOrderType(args[5]) : isRestingTif(args[5]),
      }];
    }
    case 'outcomeMarketOrder': {
      const resolved = rawClient.resolveOutcomeRef(args[0] as string | number, args[1] as string | number | undefined);
      return [{
        market: canonicalMarket(resolved.coin), kind: 'outcome', isBuy: orderSide(args[2]),
        size: finitePositive(args[3], 'size'), reduceOnly: false,
        resting: false, slippageBps: args[4] as number,
      }];
    }
    case 'twapOrder':
      return [{
        market: canonicalPerpMarket(args[0]), kind: 'perp', isBuy: orderSide(args[1]),
        size: finitePositive(args[2], 'size'), reduceOnly: asBoolean(args[5]),
        leverage: args[6] as number | undefined,
        resting: true,
      }];
    default:
      return [];
  }
}

async function loadRiskSnapshot(client: HyperliquidClient): Promise<RiskSnapshot> {
  const [state, mids, openOrders, spotBalances, spotData] = await Promise.all([
    client.getUserStateAll(),
    client.getAllMids(),
    client.getOpenOrders(),
    client.getSpotBalances(),
    client.getSpotMetaAndAssetCtxs(),
  ]);

  const prices = new Map<string, number>();
  for (const [market, raw] of Object.entries(mids)) {
    const price = parseFloat(raw);
    if (Number.isFinite(price) && price > 0) prices.set(canonicalMarket(market), price);
  }

  const holdings = new Map<string, Holding>();
  for (const item of state.assetPositions) {
    const position = item.position;
    const quantity = parseFloat(position.szi);
    if (!Number.isFinite(quantity) || quantity === 0) continue;
    const market = canonicalMarket(position.coin);
    const positionValue = Math.abs(parseFloat(position.positionValue));
    const price = positionValue > 0 ? positionValue / Math.abs(quantity) : prices.get(market) ?? 0;
    holdings.set(market, {
      quantity,
      price,
      leverage: typeof position.leverage === 'object'
        ? position.leverage.value
        : parseFloat(String(position.leverage)),
      kind: 'perp',
    });
    if (price > 0) prices.set(market, price);
  }

  const tokens = new Map(spotData.meta.tokens.map((token) => [token.index, token.name]));
  const preferredSpot = new Map<string, { market: string; price: number; quote: number }>();
  for (let i = 0; i < spotData.meta.universe.length; i++) {
    const pair = spotData.meta.universe[i];
    const base = tokens.get(pair.tokens[0]);
    if (!base) continue;
    const context = spotData.assetCtxs[i];
    const price = parseFloat(context?.midPx || context?.markPx || mids[pair.name] || '0');
    if (!Number.isFinite(price) || price <= 0) continue;
    const market = base.startsWith('+') ? `#${base.slice(1)}` : canonicalSpotMarket(base);
    const existing = preferredSpot.get(base);
    if (!existing || pair.tokens[1] === 0) {
      preferredSpot.set(base, { market, price, quote: pair.tokens[1] });
      prices.set(market, price);
    }
  }

  for (const balance of spotBalances.balances ?? []) {
    if (balance.coin.toUpperCase() === 'USDC') continue;
    const quantity = parseFloat(balance.total);
    if (!Number.isFinite(quantity) || quantity === 0) continue;
    const mapping = preferredSpot.get(balance.coin);
    if (!mapping) {
      throw new GuardrailViolation('risk-data-unavailable', `cannot price spot balance ${balance.coin}`);
    }
    holdings.set(mapping.market, {
      quantity,
      price: mapping.price,
      kind: marketKind(mapping.market),
    });
  }

  return {
    holdings,
    equity: parseFloat(state.marginSummary.accountValue),
    marginUsed: parseFloat(state.marginSummary.totalMarginUsed),
    openOrders: openOrders.length,
    prices,
    loadedAt: Date.now(),
  };
}

function totalExposure(holdings: Map<string, Holding>): number {
  let total = 0;
  for (const holding of holdings.values()) total += Math.abs(holding.quantity * holding.price);
  return total;
}

function isRiskReducing(current: number, projected: number): boolean {
  if (current === 0) return false;
  if (Math.sign(current) !== Math.sign(projected) && projected !== 0) return false;
  return Math.abs(projected) < Math.abs(current);
}

export interface GuardrailedClientOptions {
  policy: AutomationGuardrails;
  rawClient: HyperliquidClient;
  log: AutomationLogger;
  onViolation?: (error: GuardrailViolation, method: string, args: unknown[]) => void;
}

/** Wrap a client so every public write method crosses the validated policy boundary. */
export function createGuardrailedClient(
  executionClient: HyperliquidClient,
  options: GuardrailedClientOptions,
): HyperliquidClient {
  const { policy, rawClient, log, onViolation } = options;
  let snapshot: RiskSnapshot | null = null;
  let queue = Promise.resolve();
  const orderTimestamps: number[] = [];

  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function violation(error: GuardrailViolation, method: string, args: unknown[]): never {
    log.warn(`${error.message} — blocked ${method}`);
    onViolation?.(error, method, args);
    throw error;
  }

  async function enforce(method: string, originalArgs: unknown[]): Promise<{ args: unknown[]; orders: ProposedOrder[] }> {
    if (policy.mode === 'read-only') {
      throw new GuardrailViolation('read-only', `automation is read-only; ${method} is blocked`);
    }

    let args = [...originalArgs];
    if (method === 'approveBuilderFee') {
      throw new GuardrailViolation('administrative-write', 'approveBuilderFee is not allowed from automations');
    }

    if (method === 'marketOrder' || method === 'spotMarketOrder' || method === 'outcomeMarketOrder') {
      if (!policy.allowMarketOrders) {
        throw new GuardrailViolation('market-orders-disabled', `${method} is disabled by policy`);
      }
      args = prepareMarketOrderArgs(method, args, policy);
    }

    if (method === 'updateLeverage') {
      const market = canonicalPerpMarket(args[0]);
      assertAllowedMarket(policy, market);
      const leverage = finitePositive(args[1], 'leverage');
      if (!Number.isInteger(leverage) || leverage > policy.maxLeverage) {
        throw new GuardrailViolation('leverage-limit', `${leverage}x exceeds maxLeverage ${policy.maxLeverage}x`);
      }
      return { args, orders: [] };
    }

    if (method === 'cancel') assertAllowedMarket(policy, canonicalPerpMarket(args[0]));
    if (method === 'spotCancel') assertAllowedMarket(policy, canonicalSpotMarket(args[0]));
    if (method === 'twapCancel') assertAllowedMarket(policy, canonicalPerpMarket(args[0]));
    if (method === 'bulkCancel') {
      if (!Array.isArray(args[0])) throw new GuardrailViolation('invalid-cancel', 'bulkCancel requires an array');
      for (const item of args[0]) {
        if (!isPlainObject(item)) throw new GuardrailViolation('invalid-cancel', 'bulkCancel item must be an object');
        assertAllowedMarket(policy, canonicalPerpMarket(item.coin));
      }
    }
    if (method === 'cancelAll') {
      if (args[0] === undefined) {
        if (!policy.allowAccountWideCancel) {
          throw new GuardrailViolation('account-wide-cancel', 'cancelAll() without a market is disabled');
        }
      } else {
        assertAllowedMarket(policy, canonicalPerpMarket(args[0]));
      }
    }
    if (method === 'scheduleCancel' && args[0] !== undefined && !policy.allowAccountWideCancel) {
      throw new GuardrailViolation('account-wide-cancel', 'arming scheduleCancel() is disabled');
    }

    const orders = proposedOrders(method, args, rawClient);
    if (orders.length === 0) return { args, orders };
    for (const order of orders) assertAllowedMarket(policy, order.market);

    if (!snapshot || Date.now() - snapshot.loadedAt >= 1_000) {
      snapshot = await loadRiskSnapshot(rawClient);
    }

    for (const order of orders) {
      if (order.price === undefined) {
        const price = snapshot.prices.get(order.market);
        if (!price) {
          throw new GuardrailViolation('risk-data-unavailable', `cannot price ${order.market}`);
        }
        order.price = order.slippageBps === undefined
          ? price
          : price * (1 + order.slippageBps / 10_000);
      }
      if (order.leverage !== undefined) {
        finitePositive(order.leverage, 'leverage');
        if (!Number.isInteger(order.leverage) || order.leverage > policy.maxLeverage) {
          throw new GuardrailViolation(
            'leverage-limit',
            `${order.market} requested ${order.leverage}x; maximum is ${policy.maxLeverage}x`,
          );
        }
      }
    }

    let allRiskReducing = true;
    let projectedMargin = snapshot.marginUsed;
    const projectedHoldings = new Map(
      [...snapshot.holdings].map(([market, holding]) => [market, { ...holding }]),
    );
    for (const order of orders) {
      const current = projectedHoldings.get(order.market) ?? {
        quantity: 0, price: order.price!, kind: order.kind,
      };
      const signedDelta = order.isBuy ? order.size : -order.size;
      let projectedQuantity = current.quantity + signedDelta;
      if (order.kind !== 'perp' && projectedQuantity < 0) {
        throw new GuardrailViolation('insufficient-position', `${order.market} sell exceeds current balance`);
      }
      const reducing = isRiskReducing(current.quantity, projectedQuantity);

      if (order.reduceOnly && !reducing) {
        throw new GuardrailViolation('reduce-only', `${order.market} order would not reduce the current position`);
      }

      const orderNotional = order.size * order.price!;
      const projectedNotional = Math.abs(projectedQuantity * order.price!);
      if (!reducing) {
        allRiskReducing = false;
        if (orderNotional > policy.maxOrderUsd) {
          throw new GuardrailViolation(
            'order-notional',
            `${order.market} order $${orderNotional.toFixed(2)} exceeds maxOrderUsd $${policy.maxOrderUsd}`,
          );
        }
        if (projectedNotional > policy.maxPositionUsd) {
          throw new GuardrailViolation(
            'position-notional',
            `${order.market} projected exposure $${projectedNotional.toFixed(2)} exceeds maxPositionUsd $${policy.maxPositionUsd}`,
          );
        }
        if (order.kind === 'perp') {
          if (order.leverage === undefined) {
            throw new GuardrailViolation(
              'leverage-required',
              `${order.market} risk-increasing perp orders must pass an explicit leverage`,
            );
          }
          const currentNotional = Math.abs(current.quantity * current.price);
          projectedMargin += Math.max(0, projectedNotional - currentNotional) / order.leverage;
        }
      }

      if (!(order.contingent && reducing)) {
        projectedHoldings.set(order.market, {
          quantity: projectedQuantity,
          price: order.price!,
          leverage: order.leverage ?? current.leverage,
          kind: order.kind,
        });
      }
    }

    if (!allRiskReducing) {
      const exposure = totalExposure(projectedHoldings);
      if (exposure > policy.maxTotalExposureUsd) {
        throw new GuardrailViolation(
          'total-exposure',
          `projected account exposure $${exposure.toFixed(2)} exceeds maxTotalExposureUsd $${policy.maxTotalExposureUsd}`,
        );
      }
      if (!Number.isFinite(snapshot.equity) || snapshot.equity <= 0) {
        throw new GuardrailViolation('margin-limit', 'account equity is unavailable or zero');
      }
      const projectedMarginPct = (projectedMargin / snapshot.equity) * 100;
      if (projectedMarginPct > policy.maxMarginUsedPct) {
        throw new GuardrailViolation(
          'margin-limit',
          `projected margin usage ${projectedMarginPct.toFixed(2)}% exceeds maxMarginUsedPct ${policy.maxMarginUsedPct}%`,
        );
      }

      const now = Date.now();
      while (orderTimestamps.length > 0 && now - orderTimestamps[0] >= 60_000) orderTimestamps.shift();
      if (orderTimestamps.length + orders.length > policy.maxOrdersPerMinute) {
        throw new GuardrailViolation(
          'order-rate',
          `rolling order count would exceed maxOrdersPerMinute ${policy.maxOrdersPerMinute}`,
        );
      }
      const restingOrders = orders.filter((order) => order.resting).length;
      if (snapshot.openOrders + restingOrders > policy.maxOpenOrders) {
        throw new GuardrailViolation(
          'open-orders',
          `projected open orders would exceed maxOpenOrders ${policy.maxOpenOrders}`,
        );
      }
      orderTimestamps.push(...orders.map(() => now));
    }

    snapshot.holdings = projectedHoldings;
    snapshot.marginUsed = projectedMargin;
    snapshot.openOrders += orders.filter((order) => order.resting).length;
    return { args, orders };
  }

  return new Proxy(executionClient, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !CLIENT_WRITE_METHODS.has(prop) || typeof value !== 'function') {
        return value;
      }

      return (...args: unknown[]) => serialized(async () => {
        try {
          const checked = await enforce(prop, args);
          const result = await value.apply(target, checked.args);
          if (
            prop === 'cancel' || prop === 'bulkCancel' || prop === 'cancelAll' ||
            prop === 'spotCancel' || prop === 'twapCancel' || prop === 'scheduleCancel'
          ) snapshot = null;
          return result;
        } catch (error) {
          if (error instanceof GuardrailViolation) violation(error, prop, args);
          throw error;
        }
      });
    },
  });
}
