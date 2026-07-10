// Guardian — read-only position risk monitoring for Hyperliquid addresses.
// CLI/library port of the hosted copilot guardian (openbroker-copilot
// src/watcher): same six rules, same default thresholds, same severity
// contract, minus the multi-tenant DB. Alerts are delivered to the console,
// Telegram, an OpenClaw agent hook, and/or an onAlert callback.

import type { FrontendOpenOrder } from '../core/types.js';

export type GuardianRuleId =
  | 'liq_proximity'
  | 'no_tpsl'
  | 'stale_order'
  | 'margin_usage'
  | 'funding_bleed'
  | 'position_lifecycle';

export const GUARDIAN_RULE_IDS: GuardianRuleId[] = [
  'liq_proximity',
  'no_tpsl',
  'stale_order',
  'margin_usage',
  'funding_bleed',
  'position_lifecycle',
];

export const GUARDIAN_RULE_LABELS: Record<GuardianRuleId, string> = {
  liq_proximity: 'Liquidation proximity',
  no_tpsl: 'No TP/SL protection',
  stale_order: 'Stale limit orders',
  margin_usage: 'High margin usage',
  funding_bleed: 'Funding bleed',
  position_lifecycle: 'Position open / close / resize',
};

export type GuardianSeverity = 'info' | 'warning' | 'critical';

export const GUARDIAN_SEVERITY_RANK: Record<GuardianSeverity, number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

export interface GuardianAlert {
  time: number;
  address: string;
  rule: GuardianRuleId;
  coin: string | null;
  severity: GuardianSeverity;
  /** Dedup discriminator within address+rule+coin (e.g. threshold pct). */
  dedupKey: string;
  message: string;
  payload: Record<string, unknown>;
}

/** Per-run alert preferences — same contract as the hosted guardian's alert_prefs. */
export interface GuardianPrefs {
  /** Minimum severity to deliver. Default 'info'. */
  minSeverity?: GuardianSeverity;
  /** Per-rule opt-out, e.g. { position_lifecycle: false }. Default: all on. */
  rules?: Partial<Record<GuardianRuleId, boolean>>;
}

/** Rule thresholds. Defaults mirror the hosted guardian. */
export interface GuardianThresholds {
  /** Liquidation-distance tiers (fraction of mark), tightest last. */
  liqThresholds: Array<{ pct: number; severity: GuardianSeverity }>;
  /** Re-arm only after moving this multiple past a fired threshold. */
  liqRearmFactor: number;
  liqCooldownMs: number;

  marginThresholdPct: number;
  marginRearmPct: number;
  marginCooldownMs: number;

  /** Alert when a position has no reduce-only trigger after this long. */
  noTpslAfterMs: number;

  staleOrderAgeMs: number;
  /** Distance from mid (fraction) before a resting order counts as stale. */
  staleOrderDist: number;
  staleOrderCooldownMs: number;

  /** Annualized funding APR (%) the position must be paying to count as bleed. */
  fundingBleedAprPct: number;
  /** How long the bleed must persist before alerting. */
  fundingBleedForMs: number;
  fundingCooldownMs: number;
}

export const DEFAULT_GUARDIAN_THRESHOLDS: GuardianThresholds = {
  liqThresholds: [
    { pct: 0.10, severity: 'warning' },
    { pct: 0.05, severity: 'critical' },
    { pct: 0.02, severity: 'critical' },
  ],
  liqRearmFactor: 1.5,
  liqCooldownMs: 30 * 60_000,

  marginThresholdPct: 80,
  marginRearmPct: 72,
  marginCooldownMs: 60 * 60_000,

  noTpslAfterMs: 15 * 60_000,

  staleOrderAgeMs: 12 * 3600_000,
  staleOrderDist: 0.03,
  staleOrderCooldownMs: 12 * 3600_000,

  fundingBleedAprPct: 15,
  fundingBleedForMs: 60 * 60_000,
  fundingCooldownMs: 6 * 3600_000,
};

export interface GuardianPositionSnap {
  coin: string;
  szi: number;
  side: 'long' | 'short';
  entryPx: number | null;
  positionValue: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  leverage: number;
  marginUsed: number;
}

/** In-memory state per watched address. */
export interface GuardianTargetState {
  address: string;

  // clearinghouseState snapshot
  positions: Map<string, GuardianPositionSnap>;
  equity: number;
  marginUsedPct: number;
  seeded: boolean;
  lastStateAt: number | null;

  // frontendOpenOrders snapshot
  orders: FrontendOpenOrder[] | null;
  lastOrdersAt: number | null;

  /** First time each open position (coin) was observed — for the no-TP/SL rule. */
  firstSeen: Map<string, number>;
  /** Min liquidation distance (fraction) across open positions; set by the risk engine. */
  minLiqDist: number | null;
}

/** Live price entry maintained by the guardian's price feed. */
export interface GuardianPriceEntry {
  mid: number | null;
  mark: number | null;
  /** Hourly funding rate (decimal, e.g. 0.0000125). */
  funding: number | null;
  updatedAt: number;
}

/** Narrow price view the rule engine reads — tests can pass plain fakes. */
export interface GuardianPriceView {
  get(coin: string): GuardianPriceEntry | undefined;
  readonly stale: boolean;
}
