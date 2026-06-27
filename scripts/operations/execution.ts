import type { HyperliquidClient } from '../core/client.js';
import { WebSocketManager, type WsEventMap } from '../core/ws.js';
import { sleep } from '../core/utils.js';

export interface FillSummary {
  size: number;
  notional: number;
  avgPrice?: number;
}

export interface FillWatcher {
  start(): Promise<void>;
  stop(): Promise<void>;
  getFilled(oid: number): FillSummary;
  waitForFill(
    oid: number,
    targetSize: number,
    timeoutMs: number,
    options?: { coin?: string; pollMs?: number }
  ): Promise<FillSummary>;
}

type RestFill = { coin: string; px: string; sz: string; time: number; oid: number };

type FillClient = Pick<HyperliquidClient, 'address' | 'verbose'> & {
  getUserFills(user?: string): Promise<RestFill[]>;
};

export class UserFillWatcher implements FillWatcher {
  private fills = new Map<number, FillSummary>();
  private seenFills = new Set<string>();
  private ws: WebSocketManager | null;
  private ownsWs: boolean;
  private started = false;
  private readonly sinceMs: number;
  private readonly user: `0x${string}`;
  private readonly onFill = (fill: WsEventMap['userFill']) => {
    this.recordFill({
      oid: fill.oid,
      coin: fill.coin,
      px: fill.px,
      sz: fill.sz,
      time: fill.time,
    });
  };

  constructor(
    private readonly client: FillClient,
    options: { ws?: WebSocketManager | null; sinceMs?: number; user?: string } = {},
  ) {
    this.ws = options.ws === undefined ? new WebSocketManager(client.verbose) : options.ws;
    this.ownsWs = options.ws === undefined;
    this.sinceMs = options.sinceMs ?? Date.now();
    this.user = (options.user ?? client.address) as `0x${string}`;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.ws) return;
    try {
      await this.ws.connect();
      this.ws.on('userFill', this.onFill);
      await this.ws.subscribeUserFills(this.user);
    } catch {
      this.ws.off('userFill', this.onFill);
      if (this.ownsWs) await this.ws.close().catch(() => {});
      this.ws = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (!this.ws) return;
    this.ws.off('userFill', this.onFill);
    if (this.ownsWs) await this.ws.close().catch(() => {});
  }

  getFilled(oid: number): FillSummary {
    return this.fills.get(oid) ?? { size: 0, notional: 0 };
  }

  async waitForFill(
    oid: number,
    targetSize: number,
    timeoutMs: number,
    options: { coin?: string; pollMs?: number } = {},
  ): Promise<FillSummary> {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const pollMs = Math.max(250, options.pollMs ?? 1000);

    while (Date.now() <= deadline) {
      await this.refreshRestFills(options.coin);
      const filled = this.getFilled(oid);
      if (filled.size >= targetSize * 0.999) return filled;
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }

    await this.refreshRestFills(options.coin);
    return this.getFilled(oid);
  }

  private async refreshRestFills(coin?: string): Promise<void> {
    try {
      const fills = await this.client.getUserFills(this.user);
      for (const fill of fills) {
        this.recordFill(fill, coin);
      }
    } catch {
      // WebSocket is the primary path; REST polling is best-effort fallback.
    }
  }

  private recordFill(
    fill: { oid: number; coin: string; px: string; sz: string; time: number },
    expectedCoin?: string,
  ): void {
    if (expectedCoin && fill.coin !== expectedCoin) return;
    if (fill.time < this.sinceMs) return;
    const key = `${fill.oid}:${fill.time}:${fill.px}:${fill.sz}`;
    if (this.seenFills.has(key)) return;
    const size = parseFloat(fill.sz);
    const price = parseFloat(fill.px);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) return;
    this.seenFills.add(key);

    const prev = this.fills.get(fill.oid) ?? { size: 0, notional: 0 };
    const next = {
      size: prev.size + size,
      notional: prev.notional + size * price,
    };
    this.fills.set(fill.oid, {
      ...next,
      avgPrice: next.notional / next.size,
    });
  }
}
