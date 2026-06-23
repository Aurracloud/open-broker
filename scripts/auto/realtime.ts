import type { AssetCtx, ClearinghouseState, OpenOrder } from '../core/types.js';
import type {
  HyperliquidClient,
  RealtimeBookSnapshot,
  RealtimeDataProvider,
} from '../core/client.js';
import { WebSocketManager, type WsEventMap } from '../core/ws.js';

interface Timed<T> {
  value: T;
  timestamp: number;
}

const MARKET_DATA_STALE_MS = 45_000;
const BOOK_STALE_MS = 10_000;
const BOOK_SEED_TIMEOUT_MS = 1_500;

/**
 * Runtime-owned WebSocket cache used transparently by HyperliquidClient read
 * methods. While the socket is healthy, automation code calling getAllMids,
 * getUserState(All), getSpotBalances, getMetaAndAssetCtxs, or getL2Book reads
 * this cache. Missing/stale data returns null so the client falls back to REST.
 */
export class AutomationRealtimeData implements RealtimeDataProvider {
  private mids: Timed<Record<string, string>> | null = null;
  private assetCtxs: Timed<WsEventMap['allDexsAssetCtxs']['ctxs']> | null = null;
  private clearinghouse: Timed<WsEventMap['allDexsClearinghouseState']['clearinghouseStates']> | null = null;
  private spot: Timed<WsEventMap['spotState']> | null = null;
  private books = new Map<string, Timed<RealtimeBookSnapshot>>();
  private openOrders = new Map<string, Timed<OpenOrder[]>>();
  private bookSubscriptions = new Set<string>();
  private bookWaiters = new Map<string, Set<() => void>>();

  constructor(
    private readonly ws: WebSocketManager,
    private readonly client: HyperliquidClient,
    private readonly user: string,
    private readonly unified: boolean | null,
    private readonly expectedOrderDexes: string[] = [''],
  ) {
    ws.on('allMids', (data) => { this.mids = { value: data.mids, timestamp: Date.now() }; });
    ws.on('allDexsAssetCtxs', (data) => { this.assetCtxs = { value: data.ctxs, timestamp: Date.now() }; });
    ws.on('allDexsClearinghouseState', (data) => {
      this.clearinghouse = { value: data.clearinghouseStates, timestamp: Date.now() };
    });
    ws.on('spotState', (data) => { this.spot = { value: data, timestamp: Date.now() }; });
    ws.on('openOrders', (data) => {
      if (this.sameUser(data.user)) this.openOrders.set(data.dex || '', { value: data.orders, timestamp: Date.now() });
    });
    ws.on('l2Book', (data) => {
      this.books.set(data.coin, { value: data, timestamp: Date.now() });
      const waiters = this.bookWaiters.get(data.coin);
      if (waiters) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    });
  }

  get connected(): boolean {
    return this.ws.connected;
  }

  getAllMids(): Record<string, string> | null {
    return this.fresh(this.mids, MARKET_DATA_STALE_MS)?.value ?? null;
  }

  getMainAssetCtxs(): AssetCtx[] | null {
    const groups = this.fresh(this.assetCtxs, MARKET_DATA_STALE_MS)?.value;
    if (!groups) return null;
    const main = groups.find(([dex]) => !dex || dex === 'main') ?? groups[0];
    return (main?.[1] as unknown as AssetCtx[] | undefined) ?? null;
  }

  getAllDexsAssetCtxs(): WsEventMap['allDexsAssetCtxs']['ctxs'] | null {
    return this.fresh(this.assetCtxs, MARKET_DATA_STALE_MS)?.value ?? null;
  }

  getUserState(user: string, dex?: string): ClearinghouseState | null {
    if (!this.sameUser(user)) return null;
    const groups = this.clearinghouse?.value;
    if (!groups) return null;
    const targetDex = dex ?? '';
    const raw = groups.find(([name]) => (name || '') === targetDex)?.[1];
    if (!raw) return null;
    const withdrawable = raw.withdrawable;
    return {
      ...raw,
      marginSummary: raw.marginSummary && withdrawable != null
        ? { ...raw.marginSummary, withdrawable }
        : raw.marginSummary,
      crossMarginSummary: raw.crossMarginSummary && withdrawable != null
        ? { ...raw.crossMarginSummary, withdrawable }
        : raw.crossMarginSummary,
    };
  }

  getUserStateAll(user: string): ClearinghouseState | null {
    if (!this.sameUser(user) || !this.clearinghouse || this.unified === null) return null;
    return this.client.userStateAllFromWs(
      this.clearinghouse.value,
      this.unified,
      this.spot ? { balances: this.spot.value.balances } : undefined,
    );
  }

  getSpotBalances(user: string): ReturnType<RealtimeDataProvider['getSpotBalances']> {
    if (!this.sameUser(user) || !this.spot) return null;
    return {
      balances: this.spot.value.balances.map((balance) => ({
        ...balance,
        entryNtl: balance.entryNtl ?? '0',
      })),
    };
  }

  getOpenOrders(user: string): OpenOrder[] | null {
    if (!this.sameUser(user) || !this.connected) return null;
    const orders: OpenOrder[] = [];
    for (const dex of new Set(['', ...this.expectedOrderDexes])) {
      const entry = this.openOrders.get(dex);
      if (!entry) return null;
      orders.push(...entry.value);
    }
    return orders;
  }

  async getL2Book(coin: string): Promise<RealtimeBookSnapshot | null> {
    const cached = this.fresh(this.books.get(coin) ?? null, BOOK_STALE_MS);
    if (cached) return cached.value;
    if (!this.connected) return null;

    if (!this.bookSubscriptions.has(coin)) {
      this.bookSubscriptions.add(coin);
      try {
        await this.ws.subscribeL2Book(coin);
      } catch {
        this.bookSubscriptions.delete(coin);
        return null;
      }
    }

    const seeded = this.fresh(this.books.get(coin) ?? null, BOOK_STALE_MS);
    if (seeded) return seeded.value;

    await new Promise<void>((resolve) => {
      const waiters = this.bookWaiters.get(coin) ?? new Set<() => void>();
      this.bookWaiters.set(coin, waiters);
      const done = () => {
        clearTimeout(timer);
        waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, BOOK_SEED_TIMEOUT_MS);
      waiters.add(done);
    });

    return this.fresh(this.books.get(coin) ?? null, BOOK_STALE_MS)?.value ?? null;
  }

  /** Wait briefly for initial subscription snapshots before the first strategy hook runs. */
  async waitUntilReady(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.coreFeedsReady()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.coreFeedsReady();
  }

  readinessSummary(): { expectedOrderDexes: number; seededOrderDexes: number; missingOrderDexes: string[] } {
    const expected = [...new Set(['', ...this.expectedOrderDexes])];
    return {
      expectedOrderDexes: expected.length,
      seededOrderDexes: expected.filter((dex) => this.openOrders.has(dex)).length,
      missingOrderDexes: expected.filter((dex) => !this.openOrders.has(dex)),
    };
  }

  private coreFeedsReady(): boolean {
    const ordersReady = [...new Set(['', ...this.expectedOrderDexes])]
      .every((dex) => this.openOrders.has(dex));
    return Boolean(this.mids && this.assetCtxs && this.clearinghouse && this.spot && ordersReady);
  }

  private sameUser(user: string): boolean {
    return user.toLowerCase() === this.user.toLowerCase();
  }

  private fresh<T>(entry: Timed<T> | null, maxAgeMs: number): Timed<T> | null {
    if (!this.connected || !entry || Date.now() - entry.timestamp > maxAgeMs) return null;
    return entry;
  }
}
