// Trading Automation Harness — Type definitions
// The API contract that automation scripts code against

import type { HyperliquidClient } from '../core/client.js';

// ── Factory function ────────────────────────────────────────────────

/** What an automation .ts file exports */
export type AutomationFactory = (api: AutomationAPI) => void | Promise<void>;

// ── Event system ────────────────────────────────────────────────────

export type AutomationEventType =
  | 'tick'
  | 'price_change'
  | 'funding_update'
  | 'position_opened'
  | 'position_closed'
  | 'position_changed'
  | 'pnl_threshold'
  | 'margin_warning'
  | 'order_filled';

export interface AutomationEventPayloads {
  tick: { timestamp: number; pollCount: number };
  price_change: { coin: string; oldPrice: number; newPrice: number; changePct: number };
  funding_update: { coin: string; fundingRate: number; annualized: number; premium: number };
  position_opened: { coin: string; side: 'long' | 'short'; size: number; entryPrice: number };
  position_closed: { coin: string; previousSize: number; entryPrice: number };
  position_changed: { coin: string; oldSize: number; newSize: number; entryPrice: number };
  pnl_threshold: { coin: string; unrealizedPnl: number; changePct: number; positionValue: number };
  margin_warning: { marginUsedPct: number; equity: number; marginUsed: number };
  order_filled: { coin: string; oid: number; side: 'buy' | 'sell'; size: number; price: number };
}

export type AutomationEventHandler<E extends AutomationEventType> =
  (payload: AutomationEventPayloads[E]) => void | Promise<void>;

// ── State & logging ─────────────────────────────────────────────────

export interface AutomationState {
  get<T = unknown>(key: string, defaultValue?: T): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
}

export interface AutomationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

// ── Core API ────────────────────────────────────────────────────────

export interface AutomationAPI {
  /** Full Hyperliquid client (42+ methods) */
  client: HyperliquidClient;

  /** Convenience utilities from core */
  utils: {
    roundPrice: (price: number, szDecimals: number, isSpot?: boolean) => string;
    roundSize: (size: number, szDecimals: number) => string;
    sleep: (ms: number) => Promise<void>;
    normalizeCoin: (coin: string) => string;
    formatUsd: (amount: number | string) => string;
    formatPercent: (value: number | string, decimals?: number) => string;
    annualizeFundingRate: (hourlyRate: number | string) => number;
  };

  /** Subscribe to a market/account event */
  on<E extends AutomationEventType>(event: E, handler: AutomationEventHandler<E>): void;

  /** Run a handler on a recurring interval (ms). Aligned to the poll loop. */
  every(intervalMs: number, handler: () => void | Promise<void>): void;

  /** Called after all handlers are registered and polling begins */
  onStart(handler: () => void | Promise<void>): void;

  /** Called when automation is stopping (SIGINT, manual stop). Use for cleanup. */
  onStop(handler: () => void | Promise<void>): void;

  /** Called when a handler throws. The error is already logged — use this for recovery logic. */
  onError(handler: (error: Error) => void | Promise<void>): void;

  /** Persisted key-value state (~/.openbroker/state/<id>.json) */
  state: AutomationState;

  /** Structured logger */
  log: AutomationLogger;

  /** Unique automation ID (derived from filename or --id flag) */
  id: string;

  /** True if running in --dry mode (write methods are intercepted) */
  dryRun: boolean;
}

// ── Runtime internals ───────────────────────────────────────────────

export interface AutomationSnapshot {
  prices: Map<string, number>;
  positions: Map<string, PositionSnapshot>;
  openOrderIds: Set<number>;
  equity: number;
  marginUsed: number;
  marginUsedPct: number;
  fundingRates: Map<string, { rate: number; premium: number }>;
  timestamp: number;
}

export interface PositionSnapshot {
  coin: string;
  size: number;
  entryPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  leverage: number;
  marginUsed: number;
}

export interface ScheduledTask {
  intervalMs: number;
  handler: () => void | Promise<void>;
  lastRun: number;
}

export interface RunningAutomation {
  id: string;
  scriptPath: string;
  startedAt: Date;
  pollCount: number;
  eventsEmitted: number;
  dryRun: boolean;
  stop: () => Promise<void>;
}
