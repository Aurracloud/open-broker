// Guardian rule engine — pure arithmetic over in-memory target + price state,
// zero API cost per tick. Ported 1:1 from openbroker-copilot src/watcher/risk.ts
// (same thresholds, hysteresis, and cooldowns); position lifecycle events are
// emitted by the engine's snapshot diff, not here. Alerts are suppressed while
// the price feed is stale.

import type {
  GuardianAlert,
  GuardianPriceView,
  GuardianTargetState,
  GuardianThresholds,
} from './types.js';
import { DEFAULT_GUARDIAN_THRESHOLDS } from './types.js';

const HOURS_PER_YEAR = 24 * 365;

interface FiredState { firedAt: number; armed: boolean }

export type GuardianAlertHandler = (alert: GuardianAlert) => void;

export class GuardianRiskEngine {
  private readonly thresholds: GuardianThresholds;
  /** address:coin:threshold → state */
  private liqState = new Map<string, FiredState>();
  /** address → state */
  private marginState = new Map<string, FiredState>();
  /** address:coin → alerted */
  private tpslState = new Set<string>();
  /** address:oid → last fired */
  private staleOrderState = new Map<string, number>();
  /** address:coin → { since, firedAt } */
  private fundingState = new Map<string, { since: number; firedAt: number | null }>();
  private evaluations = 0;

  constructor(
    private readonly prices: GuardianPriceView,
    private readonly onAlert: GuardianAlertHandler,
    thresholds?: Partial<GuardianThresholds>,
  ) {
    this.thresholds = { ...DEFAULT_GUARDIAN_THRESHOLDS, ...thresholds };
  }

  getStats() {
    return { evaluations: this.evaluations };
  }

  /** One evaluation pass over the given targets. */
  tick(targets: Iterable<GuardianTargetState>, now = Date.now()): void {
    const stale = this.prices.stale;

    for (const target of targets) {
      if (!target.seeded) continue;
      this.updateLiqDistance(target);
      if (stale) continue; // keep distances fresh, but never alert on stale prices
      this.evaluations++;
      this.evalLiqProximity(target, now);
      this.evalMarginUsage(target, now);
      this.evalNoTpsl(target, now);
      this.evalStaleOrders(target, now);
      this.evalFundingBleed(target, now);
      this.gcClosedPositions(target);
    }
  }

  /** Distance = (mark − liqPx) / mark, signed by side. */
  private liqDistance(target: GuardianTargetState, coin: string): number | null {
    const pos = target.positions.get(coin);
    if (!pos || pos.liquidationPx === null || pos.liquidationPx <= 0) return null;
    const entry = this.prices.get(coin);
    const mark = entry?.mark ?? entry?.mid;
    if (!mark || mark <= 0) return null;
    return pos.side === 'long'
      ? (mark - pos.liquidationPx) / mark
      : (pos.liquidationPx - mark) / mark;
  }

  private updateLiqDistance(target: GuardianTargetState): void {
    let min: number | null = null;
    for (const coin of target.positions.keys()) {
      const d = this.liqDistance(target, coin);
      if (d !== null && (min === null || d < min)) min = d;
    }
    target.minLiqDist = min;
  }

  private evalLiqProximity(target: GuardianTargetState, now: number): void {
    const t = this.thresholds;
    for (const [coin, pos] of target.positions) {
      const dist = this.liqDistance(target, coin);
      if (dist === null) continue;

      for (const { pct, severity } of t.liqThresholds) {
        const key = `${target.address}:${coin}:${pct}`;
        const state = this.liqState.get(key) ?? { firedAt: 0, armed: true };

        if (!state.armed && dist >= pct * t.liqRearmFactor) {
          state.armed = true; // hysteresis re-arm
        }

        if (state.armed && dist <= pct && now - state.firedAt >= t.liqCooldownMs) {
          state.armed = false;
          state.firedAt = now;
          const entry = this.prices.get(coin);
          const mark = entry?.mark ?? entry?.mid;
          this.onAlert({
            time: now,
            address: target.address,
            rule: 'liq_proximity',
            coin,
            severity,
            dedupKey: String(pct),
            message:
              `Liquidation risk on ${coin}: mark $${mark} is ${(dist * 100).toFixed(2)}% from ` +
              `liquidation price $${pos.liquidationPx} (${pos.side}, ${pos.leverage}x)`,
            payload: { coin, distancePct: dist * 100, thresholdPct: pct * 100, mark, liquidationPx: pos.liquidationPx, side: pos.side },
          });
        }
        this.liqState.set(key, state);
      }
    }
  }

  private evalMarginUsage(target: GuardianTargetState, now: number): void {
    const t = this.thresholds;
    const key = target.address;
    const state = this.marginState.get(key) ?? { firedAt: 0, armed: true };

    if (!state.armed && target.marginUsedPct < t.marginRearmPct) state.armed = true;

    if (state.armed && target.marginUsedPct > t.marginThresholdPct && now - state.firedAt >= t.marginCooldownMs) {
      state.armed = false;
      state.firedAt = now;
      this.onAlert({
        time: now,
        address: target.address,
        rule: 'margin_usage',
        coin: null,
        severity: 'warning',
        dedupKey: String(t.marginThresholdPct),
        message: `Margin usage at ${target.marginUsedPct.toFixed(1)}% of equity ($${target.equity.toFixed(2)})`,
        payload: { marginUsedPct: target.marginUsedPct, equity: target.equity, thresholdPct: t.marginThresholdPct },
      });
    }
    this.marginState.set(key, state);
  }

  private evalNoTpsl(target: GuardianTargetState, now: number): void {
    if (target.lastOrdersAt === null || target.orders === null) return; // no order data yet

    for (const [coin, pos] of target.positions) {
      const key = `${target.address}:${coin}`;
      const openedAt = target.firstSeen.get(coin) ?? now;

      const hasProtection = target.orders.some(
        (o) => o.coin === coin && o.isTrigger && o.reduceOnly,
      );
      if (hasProtection) {
        this.tpslState.delete(key);
        continue;
      }
      if (this.tpslState.has(key)) continue;
      if (now - openedAt < this.thresholds.noTpslAfterMs) continue;

      this.tpslState.add(key);
      this.onAlert({
        time: now,
        address: target.address,
        rule: 'no_tpsl',
        coin,
        severity: 'info',
        dedupKey: 'no_tpsl',
        message: `${coin} ${pos.side} position has been open ${Math.round((now - openedAt) / 60_000)} min with no TP/SL orders`,
        payload: { coin, side: pos.side, size: pos.szi, openMinutes: Math.round((now - openedAt) / 60_000) },
      });
    }
  }

  private evalStaleOrders(target: GuardianTargetState, now: number): void {
    if (!target.orders) return;
    const t = this.thresholds;

    for (const order of target.orders) {
      if (order.isTrigger) continue; // resting limit orders only
      if (now - order.timestamp < t.staleOrderAgeMs) continue;

      const entry = this.prices.get(order.coin);
      const mid = entry?.mid ?? entry?.mark;
      const limitPx = parseFloat(order.limitPx);
      if (!mid || mid <= 0 || !Number.isFinite(limitPx)) continue;

      const dist = Math.abs(limitPx - mid) / mid;
      if (dist <= t.staleOrderDist) continue;

      const key = `${target.address}:${order.oid}`;
      const lastFired = this.staleOrderState.get(key) ?? 0;
      if (now - lastFired < t.staleOrderCooldownMs) continue;

      this.staleOrderState.set(key, now);
      const ageH = Math.round((now - order.timestamp) / 3600_000);
      this.onAlert({
        time: now,
        address: target.address,
        rule: 'stale_order',
        coin: order.coin,
        severity: 'info',
        dedupKey: String(order.oid),
        message:
          `Stale ${order.side === 'B' ? 'buy' : 'sell'} order on ${order.coin}: resting ${ageH}h, ` +
          `limit $${order.limitPx} is ${(dist * 100).toFixed(1)}% from mid $${mid}`,
        payload: { coin: order.coin, oid: order.oid, limitPx, mid, distancePct: dist * 100, ageHours: ageH },
      });
    }
  }

  private evalFundingBleed(target: GuardianTargetState, now: number): void {
    const t = this.thresholds;
    for (const [coin, pos] of target.positions) {
      const funding = this.prices.get(coin)?.funding;
      const key = `${target.address}:${coin}`;
      if (funding === null || funding === undefined) continue;

      // Longs pay when funding > 0; shorts pay when funding < 0. Funding is hourly.
      const paying = pos.side === 'long' ? funding > 0 : funding < 0;
      const aprPct = Math.abs(funding) * HOURS_PER_YEAR * 100;

      if (!paying || aprPct <= t.fundingBleedAprPct) {
        this.fundingState.delete(key);
        continue;
      }

      const state = this.fundingState.get(key) ?? { since: now, firedAt: null };
      this.fundingState.set(key, state);

      const bleedingFor = now - state.since;
      const cooledDown = state.firedAt === null || now - state.firedAt >= t.fundingCooldownMs;
      if (bleedingFor >= t.fundingBleedForMs && cooledDown) {
        state.firedAt = now;
        this.onAlert({
          time: now,
          address: target.address,
          rule: 'funding_bleed',
          coin,
          severity: 'warning',
          dedupKey: 'funding_bleed',
          message:
            `Funding bleed on ${coin}: paying ~${aprPct.toFixed(1)}% APR against your ${pos.side} ` +
            `for over ${Math.round(bleedingFor / 60_000)} min`,
          payload: { coin, side: pos.side, fundingHourly: funding, aprPct, bleedingMinutes: Math.round(bleedingFor / 60_000) },
        });
      }
    }
  }

  /** Drop per-position rule state when positions close (prevents unbounded growth). */
  private gcClosedPositions(target: GuardianTargetState): void {
    for (const key of this.tpslState) {
      const [addr, coin] = [key.slice(0, 42), key.slice(43)];
      if (addr === target.address && coin && !target.positions.has(coin)) this.tpslState.delete(key);
    }
    for (const key of this.fundingState.keys()) {
      const [addr, coin] = [key.slice(0, 42), key.slice(43)];
      if (addr === target.address && coin && !target.positions.has(coin)) this.fundingState.delete(key);
    }
  }
}
