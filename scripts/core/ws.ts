// WebSocket Manager for Hyperliquid real-time data
// Wraps @nktkas/hyperliquid SubscriptionClient with event-driven API

import { WebSocketTransport, SubscriptionClient } from '@nktkas/hyperliquid';
import type { ISubscription } from '@nktkas/hyperliquid';
import type {
  AllMidsWsEvent,
  L2BookWsEvent,
  OrderUpdatesWsEvent,
  UserFillsWsEvent,
  UserEventsWsEvent,
} from '@nktkas/hyperliquid';
import { isMainnet } from './config.js';

// ── Event types ────────────────────────────────────────────────────

export interface WsEventMap {
  /** L2 order book snapshot for a specific coin */
  l2Book: {
    coin: string;
    time: number;
    levels: [
      Array<{ px: string; sz: string; n: number }>,
      Array<{ px: string; sz: string; n: number }>,
    ];
  };
  /** Mid prices for all assets updated */
  allMids: { mids: Record<string, string> };
  /** Order status changed (filled, canceled, rejected, etc.) */
  orderUpdate: {
    order: {
      coin: string;
      side: 'B' | 'A';
      limitPx: string;
      sz: string;
      oid: number;
      timestamp: number;
      origSz: string;
      cloid?: string;
      reduceOnly?: boolean;
    };
    status: string;
    statusTimestamp: number;
  };
  /** Trade fill received */
  userFill: {
    coin: string;
    px: string;
    sz: string;
    side: 'B' | 'A';
    time: number;
    closedPnl: string;
    fee: string;
    /** Token the fee is denominated in. Spot buys typically pay fee in the base asset (e.g. "HYPE") rather than "USDC"; consumers must convert using `px` to get a USD value. */
    feeToken: string;
    oid: number;
    crossed: boolean;
  };
  /** User event (fills, funding, liquidation, non-user cancels) */
  userEvent: UserEventsWsEvent;
  /** WebSocket connected */
  connected: undefined;
  /** WebSocket disconnected */
  disconnected: { reason?: string };
  /** WebSocket error */
  error: { error: Error };
}

export type WsEventType = keyof WsEventMap;
export type WsEventHandler<E extends WsEventType> = (data: WsEventMap[E]) => void;

// ── Manager ────────────────────────────────────────────────────────

export class WebSocketManager {
  private transport: WebSocketTransport | null = null;
  private client: SubscriptionClient | null = null;
  private subscriptions: ISubscription[] = [];
  private handlers = new Map<WsEventType, Set<Function>>();
  private _connected = false;
  private verbose: boolean;

  constructor(verbose = false) {
    this.verbose = verbose;
  }

  private log(...args: unknown[]) {
    if (this.verbose) console.log('[WS]', ...args);
  }

  get connected(): boolean {
    return this._connected;
  }

  // ── Connection management ──────────────────────────────────────

  async connect(): Promise<void> {
    if (this.transport) return; // already connected

    this.transport = new WebSocketTransport({
      isTestnet: !isMainnet(),
      resubscribe: true, // auto-resubscribe on reconnect
    });

    this.client = new SubscriptionClient({ transport: this.transport });

    await this.transport.ready();
    this._connected = true;
    this.emit('connected', undefined);
    this.log('Connected to', isMainnet() ? 'mainnet' : 'testnet');
  }

  async close(): Promise<void> {
    for (const sub of this.subscriptions) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.subscriptions = [];

    if (this.transport) {
      try { await this.transport.close(); } catch { /* ignore */ }
      this.transport = null;
      this.client = null;
    }

    this._connected = false;
    this.emit('disconnected', { reason: 'manual close' });
    this.log('Closed');
  }

  // ── Event system ───────────────────────────────────────────────

  on<E extends WsEventType>(event: E, handler: WsEventHandler<E>): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  off<E extends WsEventType>(event: E, handler: WsEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler);
  }

  private emit<E extends WsEventType>(event: E, data: WsEventMap[E]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        this.log('Handler error:', err instanceof Error ? err.message : String(err));
        this.emit('error' as E, { error: err instanceof Error ? err : new Error(String(err)) } as WsEventMap[E]);
      }
    }
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }

  // ── Subscription helpers ───────────────────────────────────────

  private ensureClient(): SubscriptionClient {
    if (!this.client) throw new Error('WebSocket not connected. Call connect() first.');
    return this.client;
  }

  private trackSub(sub: ISubscription): ISubscription {
    this.subscriptions.push(sub);
    sub.failureSignal.addEventListener('abort', () => {
      this.log('Subscription failed, removing from tracked list');
      const idx = this.subscriptions.indexOf(sub);
      if (idx >= 0) this.subscriptions.splice(idx, 1);
    });
    return sub;
  }

  // ── Market data subscriptions ──────────────────────────────────

  /**
   * Subscribe to mid prices for all assets. Fires on every price update.
   */
  async subscribeAllMids(): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.allMids((data: AllMidsWsEvent) => {
      this.emit('allMids', { mids: data.mids });
    });
    return this.trackSub(sub);
  }

  /**
   * Subscribe to L2 order book snapshots for a specific coin.
   */
  async subscribeL2Book(coin: string): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.l2Book({ coin }, (data: L2BookWsEvent) => {
      this.emit('l2Book', {
        coin: data.coin,
        time: data.time,
        levels: data.levels,
      });
    });
    return this.trackSub(sub);
  }

  // ── User subscriptions ────────────────────────────────────────

  /**
   * Subscribe to order lifecycle events (fill, cancel, reject, etc.).
   * This is the most important subscription for trading automations.
   */
  async subscribeOrderUpdates(user: `0x${string}`): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.orderUpdates({ user }, (data: OrderUpdatesWsEvent) => {
      for (const update of data) {
        this.emit('orderUpdate', {
          order: {
            coin: update.order.coin,
            side: update.order.side,
            limitPx: update.order.limitPx,
            sz: update.order.sz,
            oid: update.order.oid,
            timestamp: update.order.timestamp,
            origSz: update.order.origSz,
            cloid: update.order.cloid,
            reduceOnly: update.order.reduceOnly,
          },
          status: update.status,
          statusTimestamp: update.statusTimestamp,
        });
      }
    });
    return this.trackSub(sub);
  }

  /**
   * Subscribe to trade fills for a user.
   */
  async subscribeUserFills(user: `0x${string}`): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.userFills({ user }, (data: UserFillsWsEvent) => {
      if (data.isSnapshot) return; // skip initial snapshot
      for (const fill of data.fills) {
        this.emit('userFill', {
          coin: fill.coin,
          px: fill.px,
          sz: fill.sz,
          side: fill.side,
          time: fill.time,
          closedPnl: fill.closedPnl,
          fee: fill.fee,
          feeToken: fill.feeToken,
          oid: fill.oid,
          crossed: fill.crossed,
        });
      }
    });
    return this.trackSub(sub);
  }

  /**
   * Subscribe to all user events (fills, funding, liquidations, non-user cancels).
   * This is the only way to get liquidation alerts.
   */
  async subscribeUserEvents(user: `0x${string}`): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.userEvents({ user }, (data: UserEventsWsEvent) => {
      this.emit('userEvent', data);
    });
    return this.trackSub(sub);
  }

  // ── Convenience: subscribe to all relevant feeds for an automation ──

  /**
   * Start all subscriptions needed for the automation runtime:
   * - allMids (price feed)
   * - orderUpdates (order lifecycle)
   * - userFills (trade fills)
   * - userEvents (liquidations, funding payments, system cancels)
   */
  async subscribeAll(user: `0x${string}`): Promise<void> {
    await this.connect();
    this.log('Subscribing to all feeds for', user);

    await Promise.all([
      this.subscribeAllMids(),
      this.subscribeOrderUpdates(user),
      this.subscribeUserFills(user),
      this.subscribeUserEvents(user),
    ]);

    this.log('All subscriptions active');
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let wsInstance: WebSocketManager | null = null;

export function getWebSocket(verbose = false): WebSocketManager {
  if (!wsInstance) {
    wsInstance = new WebSocketManager(verbose);
  }
  return wsInstance;
}

export function resetWebSocket(): void {
  if (wsInstance) {
    wsInstance.close().catch(() => {});
    wsInstance = null;
  }
}
