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
  AllDexsAssetCtxsWsEvent,
  AllDexsClearinghouseStateWsEvent,
  SpotStateWsEvent,
  OpenOrdersWsEvent,
} from '@nktkas/hyperliquid';
import type { ClearinghouseState, OpenOrder } from './types.js';
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
  /**
   * Asset contexts (funding / mark / oracle / OI / premium / impact) for EVERY dex — native and all
   * HIP-3 deployers — in a single push. `ctxs` is `[dexName, ctx[]]` tuples; `ctx[i]` aligns
   * positionally with that dex's `meta.universe[i]` (same join as the REST `metaAndAssetCtxs`), so a
   * consumer must hold the static universe to map index → coin. Lets a consumer drop the weight-20
   * per-dex `metaAndAssetCtxs` REST poll entirely. Fields typed are the ones we read; the SDK emits a
   * structurally-assignable superset.
   */
  allDexsAssetCtxs: {
    ctxs: Array<[
      string,
      Array<{
        funding: string;
        openInterest: string;
        dayNtlVlm: string;
        premium: string | null;
        oraclePx: string;
        markPx: string;
        midPx?: string | null;
        prevDayPx?: string;
        impactPxs?: readonly string[] | null;
      }>,
    ]>;
  };
  /**
   * Clearinghouse state (positions + margin) for EVERY dex for one user, in a single push — the WS
   * equivalent of `getUserStateAll`'s inputs. `clearinghouseStates` is `[dexName, state]` tuples
   * (dexName '' = native/main). Feed it to `client.userStateAllFromWs(...)` to get the same merged,
   * coin-canonicalized `ClearinghouseState` the REST path returns, with no REST weight.
   */
  allDexsClearinghouseState: {
    user: string;
    // Each per-dex state carries `withdrawable` at the TOP level (not inside marginSummary), like the
    // raw SDK clearinghouseState; `userStateAllFromWs` folds it into marginSummary.withdrawable to
    // match the REST getUserState shape.
    clearinghouseStates: Array<[string, ClearinghouseState & { withdrawable?: string }]>;
  };
  /** User spot balances (the shared collateral pool for unified accounts). */
  spotState: {
    balances: Array<{ coin: string; token: number; total: string; hold: string; entryNtl?: string }>;
  };
  /** Complete open-order snapshot for one user + dex (empty dex = native/main). */
  openOrders: { user: string; dex: string; orders: OpenOrder[] };
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
    /** Frontend-display direction, e.g. "Open Long" / "Close Short" / "Buy". Distinguishes opens from closes. */
    dir: string;
    /** Signed position size BEFORE this fill — lets a consumer tell a reduce/close from an open. */
    startPosition: string;
    /**
     * Present only when this fill was a forced liquidation (otherwise undefined). A consumer that
     * hedges its own fills MUST branch on this: a liquidation force-closes the leg, so the correct
     * response is to flatten the opposite hedge, NOT to place a new same-size hedge.
     */
    liquidation?: {
      liquidatedUser: string;
      markPx: string;
      method: 'market' | 'backstop';
    };
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
  private closing = false;
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
      reconnect: { maxRetries: Infinity },
    });

    const socket = this.transport.socket as unknown as WebSocket;
    socket.addEventListener('open', () => {
      if (this._connected) return;
      this._connected = true;
      this.emit('connected', undefined);
      this.log('Connected to', isMainnet() ? 'mainnet' : 'testnet');
    });
    socket.addEventListener('close', () => {
      if (!this._connected) return;
      this._connected = false;
      this.emit('disconnected', { reason: this.closing ? 'manual close' : 'socket closed' });
      this.log(this.closing ? 'Closed' : 'Disconnected; transport will reconnect');
    });
    socket.addEventListener('error', () => {
      this.emit('error', { error: new Error('Hyperliquid WebSocket transport error') });
    });

    this.client = new SubscriptionClient({ transport: this.transport });

    await this.transport.ready();
    if (!this._connected) {
      this._connected = true;
      this.emit('connected', undefined);
      this.log('Connected to', isMainnet() ? 'mainnet' : 'testnet');
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const sub of this.subscriptions) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
    }
    this.subscriptions = [];

    if (this.transport) {
      try { await this.transport.close(); } catch { /* ignore */ }
      this.transport = null;
      this.client = null;
    }

    if (this._connected) {
      this._connected = false;
      this.emit('disconnected', { reason: 'manual close' });
      this.log('Closed');
    }
    this.closing = false;
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

  /**
   * Subscribe to asset contexts for ALL dexes (native + every HIP-3 deployer) in one stream. Replaces
   * the weight-20-per-dex `metaAndAssetCtxs` REST poll for the dynamic ctx fields (funding/mark/oracle/
   * OI/premium/impact). The static universe (coin name / szDecimals / maxLeverage) is NOT in this
   * stream — keep refreshing that on a slow cadence and join positionally.
   */
  async subscribeAllDexsAssetCtxs(): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.allDexsAssetCtxs((data: AllDexsAssetCtxsWsEvent) => {
      this.emit('allDexsAssetCtxs', data as WsEventMap['allDexsAssetCtxs']);
    });
    return this.trackSub(sub);
  }

  // ── User subscriptions ────────────────────────────────────────

  /**
   * Subscribe to clearinghouse state (positions + margin) across ALL dexes for a user, in one stream.
   * Replaces per-cycle `getUserStateAll` REST polling. Pair the emitted event with
   * `client.userStateAllFromWs(...)` to reconstruct the merged, coin-canonicalized state.
   */
  async subscribeAllDexsClearinghouseState(user: `0x${string}`): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.allDexsClearinghouseState({ user }, (data: AllDexsClearinghouseStateWsEvent) => {
      this.emit('allDexsClearinghouseState', data as unknown as WsEventMap['allDexsClearinghouseState']);
    });
    return this.trackSub(sub);
  }

  /**
   * Subscribe to a user's spot balances (the unified-account collateral pool). Replaces
   * `getSpotBalances` REST polling in the collateral gate.
   */
  async subscribeSpotState(user: `0x${string}`): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.spotState({ user }, (data: SpotStateWsEvent) => {
      // The SDK event nests balances under `spotState` ({ user, spotState: { balances } }); flatten to
      // the same `{ balances }` shape the REST getSpotBalances returns so consumers are uniform.
      const balances = (data as { spotState?: { balances?: WsEventMap['spotState']['balances'] } }).spotState?.balances ?? [];
      this.emit('spotState', { balances });
    });
    return this.trackSub(sub);
  }

  /** Subscribe to complete open-order snapshots for one dex. */
  async subscribeOpenOrders(user: `0x${string}`, dex = ''): Promise<ISubscription> {
    const client = this.ensureClient();
    const sub = await client.openOrders({ user, dex }, (data: OpenOrdersWsEvent) => {
      this.emit('openOrders', {
        user: data.user,
        dex: data.dex,
        orders: data.orders as unknown as OpenOrder[],
      });
    });
    return this.trackSub(sub);
  }

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
          dir: fill.dir,
          startPosition: fill.startPosition,
          liquidation: fill.liquidation,
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
   * - allDexsAssetCtxs (funding / mark / oracle contexts)
   * - allDexsClearinghouseState + spotState (positions, margin, balances)
   * - openOrders for main + requested HIP-3 dexes
   * - orderUpdates (order lifecycle)
   * - userFills (trade fills)
   * - userEvents (liquidations, funding payments, system cancels)
   */
  async subscribeAll(user: `0x${string}`, dexNames: string[] = []): Promise<void> {
    await this.connect();
    this.log('Subscribing to all feeds for', user);

    await Promise.all([
      this.subscribeAllMids(),
      this.subscribeAllDexsAssetCtxs(),
      this.subscribeAllDexsClearinghouseState(user),
      this.subscribeSpotState(user),
      this.subscribeOpenOrders(user),
      ...dexNames.map((dex) => this.subscribeOpenOrders(user, dex)),
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
