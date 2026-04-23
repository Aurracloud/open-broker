// Trading Automation Harness — Type definitions
// The API contract that automation scripts code against

import type { HyperliquidClient } from '../core/client.js';

// ── Factory function ────────────────────────────────────────────────

/** What an automation .ts file exports */
export type AutomationFactory = (api: AutomationAPI) => void | Promise<void>;

/** Config field descriptor for example automations */
export interface AutomationConfigField {
  type: 'string' | 'number' | 'boolean';
  description: string;
  default: unknown;
  required?: boolean;
}

/** Config metadata exported by example automations as `export const config` */
export interface AutomationConfig {
  description: string;
  fields: Record<string, AutomationConfigField>;
}

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
  | 'order_filled'
  | 'order_update'
  | 'liquidation';

export interface AutomationEventPayloads {
  tick: { timestamp: number; pollCount: number };
  price_change: { coin: string; oldPrice: number; newPrice: number; changePct: number };
  funding_update: { coin: string; fundingRate: number; annualized: number; premium: number };
  position_opened: { coin: string; side: 'long' | 'short'; size: number; entryPrice: number };
  position_closed: { coin: string; previousSize: number; entryPrice: number };
  position_changed: { coin: string; oldSize: number; newSize: number; entryPrice: number };
  pnl_threshold: { coin: string; unrealizedPnl: number; changePct: number; positionValue: number };
  margin_warning: { marginUsedPct: number; equity: number; marginUsed: number };
  /**
   * Fires on every trade fill — partial and terminal — sourced from the
   * Hyperliquid `userFills` WS stream. `size` is the fill delta (NOT remaining
   * size of the order). `fee` and `closedPnl` are in USD; `crossed` is true
   * when this side was the taker. Fee/pnl/crossed are optional so that older
   * consumers that only read coin/oid/side/size/price keep working.
   */
  order_filled: {
    coin: string;
    oid: number;
    side: 'buy' | 'sell';
    size: number;
    price: number;
    fee?: number;
    closedPnl?: number;
    crossed?: boolean;
  };
  /** Real-time order lifecycle event via WebSocket (filled, canceled, rejected, triggered, etc.) */
  order_update: {
    coin: string;
    oid: number;
    side: 'buy' | 'sell';
    size: number;
    price: number;
    origSize: number;
    status: string;
    statusTimestamp: number;
  };
  /** Liquidation event via WebSocket — only source for liquidation alerts */
  liquidation: {
    lid: number;
    liquidator: string;
    liquidatedUser: string;
    liquidatedNtlPos: number;
    liquidatedAccountValue: number;
  };
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

export interface AutomationAudit {
  /** Record a custom audit note for later reporting. */
  record(kind: string, payload?: unknown): void;
  /** Record a numeric metric with optional dimensions/tags. */
  metric(name: string, value: number, tags?: Record<string, unknown>): void;
}

// ── Publish (webhook) ───────────────────────────────────────────────

export interface PublishOptions {
  /** Human-readable name for the hook (appears in logs). Default: "ob-auto-<id>" */
  name?: string;
  /** Wake mode: "now" triggers immediate agent turn, "next-heartbeat" queues. Default: "now" */
  wakeMode?: 'now' | 'next-heartbeat';
  /** Whether to deliver the agent response to messaging channels. Default: true */
  deliver?: boolean;
  /** Target channel (e.g. "slack", "telegram", "last"). Default: agent decides */
  channel?: string;
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

  /**
   * Publish a message to the OpenClaw agent via webhook.
   * Sends to POST /hooks/agent on the local gateway, triggering an agent turn.
   * The agent receives the message and can act on it (notify user, trade, etc.).
   *
   * @param message — The message string the agent will receive
   * @param options — Optional: name, wakeMode, deliver, channel
   * @returns true if delivered, false if webhook is not configured
   */
  publish(message: string, options?: PublishOptions): Promise<boolean>;

  /** Persisted key-value state (~/.openbroker/state/<id>.json) */
  state: AutomationState;

  /** Structured logger */
  log: AutomationLogger;

  /** Local audit trail persisted to ~/.openbroker/automation-audit.sqlite */
  audit: AutomationAudit;

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
  /**
   * Stop the automation.
   * @param opts.persist If false, keep the entry in the file registry so it
   *   restarts when the gateway comes back up. Default: true (fully remove).
   */
  stop: (opts?: { persist?: boolean }) => Promise<void>;
}
