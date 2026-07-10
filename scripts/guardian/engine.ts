// Guardian engine: REST poll (clearinghouseState + frontendOpenOrders) + price
// feed + rule engine + alert dispatch. Read-only — never places orders. This is
// the CLI/library counterpart of the hosted guardian's watcher: same rules and
// cadences, scaled down from a multi-tenant fleet to the handful of addresses a
// CLI user or agent watches, so no weight budget or tier queue is needed.

import { getClient, type HyperliquidClient } from '../core/client.js';
import { getWebSocket, resetWebSocket } from '../core/ws.js';
import type { ClearinghouseState, FrontendOpenOrder } from '../core/types.js';
import { GuardianRiskEngine } from './rules.js';
import {
  formatTelegramAlert,
  loadTelegramSettings,
  sendTelegramMessage,
} from './telegram.js';
import type {
  GuardianAlert,
  GuardianPositionSnap,
  GuardianPrefs,
  GuardianPriceEntry,
  GuardianTargetState,
  GuardianThresholds,
} from './types.js';
import { GUARDIAN_SEVERITY_RANK } from './types.js';

/** Price entries older than this are stale — alerts are suppressed. */
const PRICE_STALE_MS = 120_000;
/** Poll clearinghouseState this often when a position is within 10% of liquidation. */
const HOT_STATE_INTERVAL_MS = 15_000;
const HOT_LIQ_DIST = 0.10;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export interface GuardianTelegramChannel {
  token: string;
  chatId: string;
}

export interface GuardianAgentHookChannel {
  hooksToken: string;
  gatewayPort?: number;
}

export interface GuardianOptions {
  /** Addresses to watch. Default: the configured account address. */
  addresses?: string[];
  /** Min severity + per-rule opt-out (same contract as the hosted guardian). */
  prefs?: GuardianPrefs;
  /** Rule threshold overrides. */
  thresholds?: Partial<GuardianThresholds>;
  /** clearinghouseState cadence (ms). Default 30s; drops to 15s near liquidation. */
  pollIntervalMs?: number;
  /** frontendOpenOrders cadence (ms). Default 120s. */
  ordersIntervalMs?: number;
  /** Price (mids + main-dex ctxs) cadence (ms). Default 30s. */
  pricesIntervalMs?: number;
  /** HIP-3 mark/funding cadence (ms), fetched only while HIP-3 positions exist. Default 5m. */
  hip3PricesIntervalMs?: number;
  /** Rule-engine tick (ms), pure in-memory. Default 5s. */
  riskIntervalMs?: number;
  /**
   * Subscribe WS userEvents for instant liquidation alerts and fill-triggered
   * re-polls. Only active when exactly one address is watched (the feed is not
   * tagged per user). Default true.
   */
  useWebSocket?: boolean;
  /** Telegram channel. Default: from TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID env. Pass false to disable. */
  telegram?: GuardianTelegramChannel | false;
  /** OpenClaw agent hook channel. Default: from OPENCLAW_HOOKS_TOKEN/OPENCLAW_GATEWAY_PORT env. Pass false to disable. */
  agentHook?: GuardianAgentHookChannel | false;
  /** Print alerts as JSON lines instead of human-readable text. */
  json?: boolean;
  /** Suppress console alert output entirely (library consumers). */
  quiet?: boolean;
  verbose?: boolean;
  /** Callback fired for every alert that passes prefs. */
  onAlert?: (alert: GuardianAlert) => void;
  /** Injectable client (tests / plugin). Default getClient(). */
  client?: HyperliquidClient;
}

export interface GuardianStats {
  addresses: string[];
  statePolls: number;
  orderPolls: number;
  alertsFired: number;
  alertsDelivered: number;
  deliveryErrors: number;
  evaluations: number;
  pricesAt: number | null;
  channels: string[];
}

export interface GuardianHandle {
  stop(): Promise<void>;
  getStats(): GuardianStats;
  getTargets(): GuardianTargetState[];
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parsePositions(state: ClearinghouseState): Map<string, GuardianPositionSnap> {
  const out = new Map<string, GuardianPositionSnap>();
  for (const ap of state.assetPositions ?? []) {
    const p = ap.position;
    const szi = num(p.szi);
    if (szi === null || szi === 0) continue;
    out.set(p.coin, {
      coin: p.coin,
      szi,
      side: szi > 0 ? 'long' : 'short',
      entryPx: num(p.entryPx),
      positionValue: num(p.positionValue) ?? 0,
      unrealizedPnl: num(p.unrealizedPnl) ?? 0,
      liquidationPx: num(p.liquidationPx ?? null),
      leverage: p.leverage?.value ?? 0,
      marginUsed: num(p.marginUsed) ?? 0,
    });
  }
  return out;
}

export class Guardian {
  private readonly client: HyperliquidClient;
  private readonly targets = new Map<string, GuardianTargetState>();
  private readonly prices = new Map<string, GuardianPriceEntry>();
  private readonly risk: GuardianRiskEngine;
  private readonly prefs: GuardianPrefs;
  private readonly telegram: GuardianTelegramChannel | null;
  private readonly agentHook: GuardianAgentHookChannel | null;
  private readonly opts: GuardianOptions;

  private timers: Array<ReturnType<typeof setInterval>> = [];
  private wsSubs: Array<{ unsubscribe(): Promise<void> }> = [];
  private wsUsed = false;
  private stopped = false;
  private polling = false;

  private statePolls = 0;
  private orderPolls = 0;
  private alertsFired = 0;
  private alertsDelivered = 0;
  private deliveryErrors = 0;
  private lastPricesAt: number | null = null;

  constructor(addresses: string[], opts: GuardianOptions = {}) {
    this.opts = opts;
    this.client = opts.client ?? getClient();
    this.prefs = opts.prefs ?? {};

    for (const address of addresses) {
      this.targets.set(address, {
        address,
        positions: new Map(),
        equity: 0,
        marginUsedPct: 0,
        seeded: false,
        lastStateAt: null,
        orders: null,
        lastOrdersAt: null,
        firstSeen: new Map(),
        minLiqDist: null,
      });
    }

    const self = this;
    const priceView = {
      get: (coin: string) => self.prices.get(coin),
      // Stale when nothing has refreshed within the window (or nothing seeded yet).
      get stale(): boolean {
        return self.lastPricesAt === null || Date.now() - self.lastPricesAt > PRICE_STALE_MS;
      },
    };
    this.risk = new GuardianRiskEngine(priceView, (alert) => void this.dispatch(alert), opts.thresholds);

    if (opts.telegram === false) {
      this.telegram = null;
    } else if (opts.telegram) {
      this.telegram = opts.telegram;
    } else {
      const settings = loadTelegramSettings();
      this.telegram = settings.token && settings.chatId
        ? { token: settings.token, chatId: settings.chatId }
        : null;
    }

    if (opts.agentHook === false) {
      this.agentHook = null;
    } else if (opts.agentHook) {
      this.agentHook = opts.agentHook;
    } else {
      const hooksToken = process.env.OPENCLAW_HOOKS_TOKEN;
      const portStr = process.env.OPENCLAW_GATEWAY_PORT;
      const gatewayPort = portStr ? parseInt(portStr, 10) : undefined;
      this.agentHook = hooksToken
        ? { hooksToken, gatewayPort: gatewayPort && !isNaN(gatewayPort) ? gatewayPort : undefined }
        : null;
    }
  }

  channels(): string[] {
    const out = ['console'];
    if (this.telegram) out.push('telegram');
    if (this.agentHook) out.push('agent-hook');
    if (this.opts.onAlert) out.push('callback');
    return out;
  }

  async start(): Promise<void> {
    const pollMs = this.opts.pollIntervalMs ?? 30_000;
    const ordersMs = this.opts.ordersIntervalMs ?? 120_000;
    const pricesMs = this.opts.pricesIntervalMs ?? 30_000;
    const hip3Ms = this.opts.hip3PricesIntervalMs ?? 300_000;
    const riskMs = this.opts.riskIntervalMs ?? 5_000;

    // Seed everything once before the intervals so the first risk tick has data.
    await this.refreshPrices();
    await this.refreshHip3Prices();
    for (const target of this.targets.values()) {
      await this.pollState(target);
      await this.pollOrders(target);
    }

    this.timers.push(setInterval(() => void this.pollAllStates(pollMs), Math.min(pollMs, HOT_STATE_INTERVAL_MS)));
    this.timers.push(setInterval(() => void this.pollAllOrders(), ordersMs));
    this.timers.push(setInterval(() => void this.refreshPrices(), pricesMs));
    this.timers.push(setInterval(() => void this.refreshHip3Prices(), hip3Ms));
    this.timers.push(setInterval(() => this.risk.tick(this.targets.values()), riskMs));

    if ((this.opts.useWebSocket ?? true) && this.targets.size === 1) {
      await this.startWebSocket();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const sub of this.wsSubs) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.wsSubs = [];
    if (this.wsUsed) {
      try { await resetWebSocket(); } catch { /* ignore */ }
    }
  }

  getStats(): GuardianStats {
    return {
      addresses: [...this.targets.keys()],
      statePolls: this.statePolls,
      orderPolls: this.orderPolls,
      alertsFired: this.alertsFired,
      alertsDelivered: this.alertsDelivered,
      deliveryErrors: this.deliveryErrors,
      evaluations: this.risk.getStats().evaluations,
      pricesAt: this.lastPricesAt,
      channels: this.channels(),
    };
  }

  getTargets(): GuardianTargetState[] {
    return [...this.targets.values()];
  }

  // ── WebSocket fast lane (single-address runs) ─────────────────────

  private async startWebSocket(): Promise<void> {
    const address = [...this.targets.keys()][0] as `0x${string}`;
    try {
      const ws = getWebSocket();
      this.wsUsed = true;
      if (!ws.connected) await ws.connect();
      ws.on('userEvent', (data) => {
        if (this.stopped) return;
        if ('liquidation' in data && data.liquidation) {
          const liq = data.liquidation as { lid?: number; liquidated_account_value?: string };
          void this.dispatch({
            time: Date.now(),
            address,
            rule: 'liq_proximity',
            coin: null,
            severity: 'critical',
            dedupKey: `liquidated:${liq.lid ?? Date.now()}`,
            message: `LIQUIDATED: account was liquidated (account value $${liq.liquidated_account_value ?? '?'})`,
            payload: { kind: 'liquidation', ...liq },
          });
          void this.pollState(this.targets.get(address)!);
        } else if ('fills' in data && Array.isArray(data.fills)) {
          for (const fill of data.fills) {
            const liq = (fill as { liquidation?: { markPx?: string } }).liquidation;
            if (liq) {
              void this.dispatch({
                time: Date.now(),
                address,
                rule: 'liq_proximity',
                coin: (fill as { coin?: string }).coin ?? null,
                severity: 'critical',
                dedupKey: `liq-fill:${(fill as { tid?: number }).tid ?? Date.now()}`,
                message: `LIQUIDATED: forced ${(fill as { dir?: string }).dir ?? 'close'} on ${(fill as { coin?: string }).coin ?? '?'} at mark $${liq.markPx ?? '?'}`,
                payload: { kind: 'liquidation_fill', fill },
              });
            }
          }
          // Any fill: re-poll state now so lifecycle diffs land fast.
          void this.pollState(this.targets.get(address)!);
        }
      });
      ws.on('error', () => { /* reconnects internally; REST polling continues regardless */ });
      this.wsSubs.push(await ws.subscribeUserEvents(address));
      this.log(`WS userEvents subscribed for ${address}`);
    } catch (err) {
      this.log(`WS unavailable, continuing REST-only: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Price feed (REST) ─────────────────────────────────────────────

  private hasHip3Positions(): boolean {
    for (const target of this.targets.values()) {
      for (const coin of target.positions.keys()) {
        if (coin.includes(':')) return true;
      }
    }
    return false;
  }

  private async refreshPrices(): Promise<void> {
    const now = Date.now();
    try {
      const [mids, meta] = await Promise.all([
        this.client.getAllMids(),
        this.client.getMetaAndAssetCtxs(),
      ]);

      for (const [coin, mid] of Object.entries(mids)) {
        const entry = this.prices.get(coin) ?? { mid: null, mark: null, funding: null, updatedAt: 0 };
        entry.mid = num(mid);
        entry.updatedAt = now;
        this.prices.set(coin, entry);
      }

      for (let i = 0; i < meta.meta.universe.length; i++) {
        const coin = meta.meta.universe[i].name;
        const ctx = meta.assetCtxs[i];
        if (!ctx) continue;
        const entry = this.prices.get(coin) ?? { mid: null, mark: null, funding: null, updatedAt: 0 };
        entry.mark = num(ctx.markPx);
        entry.funding = num(ctx.funding);
        entry.updatedAt = now;
        this.prices.set(coin, entry);
      }

      this.lastPricesAt = now;
    } catch (err) {
      this.log(`price refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** HIP-3 mark/funding — heavier (per-dex metaAndAssetCtxs), only while HIP-3 positions exist. */
  private async refreshHip3Prices(): Promise<void> {
    if (!this.hasHip3Positions()) return;
    const now = Date.now();
    try {
      const allPerps = await this.client.getAllPerpMetas();
      for (const dexData of allPerps) {
        if (!dexData.dexName) continue; // main dex handled by refreshPrices
        for (let i = 0; i < dexData.meta.universe.length; i++) {
          const coin = dexData.meta.universe[i].name; // already dex-prefixed, e.g. "hyna:XMR"
          const ctx = dexData.assetCtxs[i];
          if (!ctx) continue;
          const entry = this.prices.get(coin) ?? { mid: null, mark: null, funding: null, updatedAt: 0 };
          entry.mark = num(ctx.markPx);
          entry.funding = num(ctx.funding);
          if (entry.mid === null) entry.mid = num(ctx.midPx ?? ctx.markPx);
          entry.updatedAt = now;
          this.prices.set(coin, entry);
        }
      }
    } catch (err) {
      this.log(`HIP-3 price refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── State + orders polling ────────────────────────────────────────

  private async pollAllStates(baseIntervalMs: number): Promise<void> {
    if (this.polling) return; // don't overlap slow cycles
    this.polling = true;
    try {
      const now = Date.now();
      for (const target of this.targets.values()) {
        // Hot cadence near liquidation, base cadence otherwise. The interval
        // fires at min(base, 15s); skip targets whose cadence isn't due.
        const nearLiq = target.minLiqDist !== null && target.minLiqDist < HOT_LIQ_DIST;
        const interval = nearLiq ? Math.min(baseIntervalMs, HOT_STATE_INTERVAL_MS) : baseIntervalMs;
        if (target.lastStateAt !== null && now - target.lastStateAt < interval - 500) continue;
        await this.pollState(target);
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollAllOrders(): Promise<void> {
    for (const target of this.targets.values()) {
      await this.pollOrders(target);
    }
  }

  private async pollState(target: GuardianTargetState): Promise<void> {
    const now = Date.now();
    try {
      const state = await this.client.getUserStateAll(target.address);
      const positions = parsePositions(state);

      const events = target.seeded ? this.diff(target, positions) : [];

      // Maintain firstSeen for the no-TP/SL rule.
      for (const coin of positions.keys()) {
        if (!target.firstSeen.has(coin)) target.firstSeen.set(coin, now);
      }
      for (const coin of [...target.firstSeen.keys()]) {
        if (!positions.has(coin)) target.firstSeen.delete(coin);
      }

      const equity = num(state.marginSummary?.accountValue) ?? 0;
      const marginUsed = num(state.marginSummary?.totalMarginUsed) ?? 0;

      target.positions = positions;
      target.equity = equity;
      target.marginUsedPct = equity > 0 ? (marginUsed / equity) * 100 : 0;
      target.seeded = true;
      target.lastStateAt = now;
      this.statePolls++;

      for (const event of events) void this.dispatch(event);
    } catch (err) {
      this.log(`state poll failed for ${target.address}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async pollOrders(target: GuardianTargetState): Promise<void> {
    try {
      const orders: FrontendOpenOrder[] = await this.client.getFrontendOpenOrders(target.address);
      // HIP-3 positions rest their TP/SL on their own dex — include those books
      // so the no-TP/SL rule doesn't false-positive.
      const dexes = new Set<string>();
      for (const coin of target.positions.keys()) {
        const idx = coin.indexOf(':');
        if (idx > 0) dexes.add(coin.slice(0, idx));
      }
      for (const dex of dexes) {
        try {
          orders.push(...await this.client.getFrontendOpenOrders(target.address, dex));
        } catch (err) {
          this.log(`orders poll failed for dex ${dex}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      target.orders = orders;
      target.lastOrdersAt = Date.now();
      this.orderPolls++;
    } catch (err) {
      this.log(`orders poll failed for ${target.address}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Snapshot diff → position lifecycle alerts (mirrors the hosted poller). */
  private diff(target: GuardianTargetState, current: Map<string, GuardianPositionSnap>): GuardianAlert[] {
    const now = Date.now();
    const events: GuardianAlert[] = [];
    const prev = target.positions;

    for (const [coin, pos] of current) {
      if (!prev.has(coin)) {
        events.push({
          time: now,
          address: target.address,
          rule: 'position_lifecycle',
          coin,
          severity: 'info',
          dedupKey: `opened:${now}`,
          message: `Position opened: ${pos.side} ${Math.abs(pos.szi)} ${coin} at $${pos.entryPx ?? '?'}`,
          payload: { kind: 'opened', coin, side: pos.side, size: pos.szi, entryPx: pos.entryPx },
        });
      }
    }

    for (const [coin, pos] of prev) {
      if (!current.has(coin)) {
        events.push({
          time: now,
          address: target.address,
          rule: 'position_lifecycle',
          coin,
          severity: 'info',
          dedupKey: `closed:${now}`,
          message: `Position closed: ${coin} (was ${pos.szi} at $${pos.entryPx ?? '?'}, last uPnL $${pos.unrealizedPnl.toFixed(2)})`,
          payload: { kind: 'closed', coin, previousSize: pos.szi, entryPx: pos.entryPx, lastPnl: pos.unrealizedPnl },
        });
      }
    }

    for (const [coin, pos] of current) {
      const prevPos = prev.get(coin);
      if (!prevPos || prevPos.szi === pos.szi) continue;
      const change = pos.szi - prevPos.szi;
      const action = Math.abs(pos.szi) > Math.abs(prevPos.szi) ? 'increased' : 'decreased';
      events.push({
        time: now,
        address: target.address,
        rule: 'position_lifecycle',
        coin,
        severity: 'info',
        dedupKey: `size:${now}`,
        message: `Position ${coin} size ${action}: ${prevPos.szi} → ${pos.szi} (${change > 0 ? '+' : ''}${change.toFixed(6)})`,
        payload: { kind: 'size_changed', coin, previousSize: prevPos.szi, newSize: pos.szi, change },
      });
    }

    return events;
  }

  // ── Dispatch ──────────────────────────────────────────────────────

  private passesPrefs(alert: GuardianAlert): boolean {
    if (this.prefs.rules?.[alert.rule] === false) return false;
    const min = this.prefs.minSeverity ?? 'info';
    return GUARDIAN_SEVERITY_RANK[alert.severity] >= GUARDIAN_SEVERITY_RANK[min];
  }

  private async dispatch(alert: GuardianAlert): Promise<void> {
    if (!this.passesPrefs(alert)) return;
    this.alertsFired++;

    if (!this.opts.quiet) {
      if (this.opts.json) {
        console.log(JSON.stringify(alert));
      } else {
        const time = new Date(alert.time).toISOString().slice(11, 19);
        const scope = alert.coin ? ` ${alert.coin}` : '';
        console.log(`[${time}] ${alert.severity.toUpperCase()} ${alert.rule}${scope} — ${alert.message}`);
      }
    }

    try {
      this.opts.onAlert?.(alert);
    } catch (err) {
      this.log(`onAlert callback threw: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (this.telegram) {
      try {
        await sendTelegramMessage(this.telegram.token, this.telegram.chatId, formatTelegramAlert(alert));
        this.alertsDelivered++;
      } catch (err) {
        this.deliveryErrors++;
        this.log(`telegram delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (this.agentHook) {
      try {
        const port = this.agentHook.gatewayPort ?? 18789;
        const res = await fetch(`http://127.0.0.1:${port}/hooks/agent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.agentHook.hooksToken}`,
          },
          body: JSON.stringify({
            message: `[guardian] [${alert.severity}] ${alert.message}`,
            name: 'openbroker-guardian',
            wakeMode: 'now',
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) this.alertsDelivered++;
        else {
          this.deliveryErrors++;
          this.log(`agent hook delivery failed: HTTP ${res.status}`);
        }
      } catch (err) {
        this.deliveryErrors++;
        this.log(`agent hook delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private log(message: string): void {
    if (this.opts.verbose) console.error(`[guardian] ${message}`);
  }
}

/** Start watching. Resolves once the first snapshot is seeded. */
export async function startGuardian(opts: GuardianOptions = {}): Promise<GuardianHandle> {
  const client = opts.client ?? getClient();
  const addresses = (opts.addresses && opts.addresses.length > 0 ? opts.addresses : [client.address])
    .map((a) => a.toLowerCase());

  for (const address of addresses) {
    if (!ADDR_RE.test(address)) {
      throw new Error(`Invalid address: ${address}. Pass --address 0x... or configure HYPERLIQUID_ACCOUNT_ADDRESS.`);
    }
  }

  const guardian = new Guardian(addresses, { ...opts, client });
  await guardian.start();
  return guardian;
}
