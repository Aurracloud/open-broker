// Hyperliquid Client for Open Broker
// Uses @nktkas/hyperliquid SDK

import { HttpTransport, InfoClient, ExchangeClient } from '@nktkas/hyperliquid';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type {
  OpenBrokerConfig,
  BuilderInfo,
  OrderResponse,
  CancelResponse,
  MetaAndAssetCtxs,
  ClearinghouseState,
  OpenOrder,
} from './types.js';
import { loadConfig, isMainnet } from './config.js';
import { roundPrice, roundSize } from './utils.js';

export class HyperliquidClient {
  private config: OpenBrokerConfig;
  private account: PrivateKeyAccount;
  private transport: HttpTransport;
  private info: InfoClient;
  private exchange: ExchangeClient;

  private meta: MetaAndAssetCtxs | null = null;
  private assetMap: Map<string, number> = new Map();
  private szDecimalsMap: Map<string, number> = new Map();
  /** Maps coin name → dex info for HIP-3 assets. Main dex assets have dexName=null */
  private coinDexMap: Map<string, { dexName: string | null; dexIdx: number; localName: string }> = new Map();
  /** Cache of perpDexs list */
  private perpDexsCache: Array<{ name: string; fullName: string; deployer: string } | null> | null = null;
  /** Whether HIP-3 assets have been loaded into maps */
  private hip3Loaded: boolean = false;
  /** Whether API wallet setup has been validated */
  private apiWalletValidated: boolean = false;
  /** Set of HIP-3 dex names that have been loaded (for testnet on-demand loading) */
  private loadedHip3Dexes: Set<string> = new Set();
  /** HIP-3 assets that have had isolated margin set this session */
  private hip3IsolatedSet: Set<string> = new Set();
  /** Cached maxLeverage for HIP-3 assets */
  private hip3MaxLeverageMap: Map<string, number> = new Map();
  /** Cached account abstraction mode: 'standard' | 'unified' | 'portfolio' | 'dexAbstraction' */
  private accountMode: string | null = null;
  /** Spot asset index map: coin name → 10000 + spotMeta.universe[i].index */
  private spotAssetMap: Map<string, number> = new Map();
  /** Spot market key map: coin name → pair.name (e.g. "@230", "PURR/USDC") */
  private spotPairNameMap: Map<string, string> = new Map();
  /** Spot szDecimals map: coin name → base token szDecimals */
  private spotSzDecimalsMap: Map<string, number> = new Map();
  /** Whether spot metadata has been loaded */
  private spotMetaLoaded: boolean = false;
  public verbose: boolean = false;

  constructor(config?: OpenBrokerConfig) {
    this.config = config ?? loadConfig();
    this.account = privateKeyToAccount(this.config.privateKey);
    this.verbose = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

    // Initialize SDK clients
    this.transport = new HttpTransport({ isTestnet: !isMainnet() });
    this.info = new InfoClient({ transport: this.transport });
    this.exchange = new ExchangeClient({
      transport: this.transport,
      wallet: this.account,
    });

    this.log(
      'Client init:',
      JSON.stringify({
        network: isMainnet() ? 'mainnet' : 'testnet',
        apiUrl: this.config.baseUrl,
        accountAddress: this.config.accountAddress,
        walletAddress: this.config.walletAddress,
        isApiWallet: this.config.isApiWallet,
        isReadOnly: this.config.isReadOnly,
      })
    );
  }

  private log(...args: unknown[]) {
    if (this.verbose) {
      console.log('[DEBUG]', ...args);
    }
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error);

    const response = (error as Error & { response?: Response }).response;
    const body = (error as Error & { body?: string }).body;
    const cause = (error as Error & { cause?: unknown }).cause;
    const parts = [error.message];

    if (response) {
      parts.push(`status=${response.status} ${response.statusText}`.trim());
    }

    if (body) {
      parts.push(`body=${body.length > 300 ? `${body.slice(0, 300)}...` : body}`);
    }

    if (cause instanceof Error && cause.message && cause.message !== error.message) {
      parts.push(`cause=${cause.message}`);
    } else if (cause && !(cause instanceof Error)) {
      parts.push(`cause=${String(cause)}`);
    }

    return parts.join(' | ');
  }

  /** Retry an async operation on transient failures (fetch failed, ECONNRESET, etc.) */
  private async withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isTransient = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(message);
        if (!isTransient || attempt === maxRetries) throw error;
        const delay = attempt * 1000; // 1s, 2s, 3s
        this.log(`${label} attempt ${attempt}/${maxRetries} failed (${message}), retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('unreachable');
  }

  private getTransportContext(label: string): string {
    return JSON.stringify({
      label,
      network: isMainnet() ? 'mainnet' : 'testnet',
      apiUrl: this.config.baseUrl,
      accountAddress: this.config.accountAddress,
      walletAddress: this.config.walletAddress,
      isApiWallet: this.config.isApiWallet,
      isReadOnly: this.config.isReadOnly,
      verbose: this.verbose,
    });
  }

  private async postInfo<T>(payload: Record<string, unknown>, label: string): Promise<T> {
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await this.withRetry(async () => {
      try {
        return await fetch(baseUrl + '/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} request failed before response: ${message}`);
      }
    }, label);

    const text = await response.text();
    if (!response.ok) {
      const snippet = text.length > 300 ? `${text.slice(0, 300)}...` : text;
      throw new Error(
        `${label} failed: HTTP ${response.status} ${response.statusText}${snippet ? ` | body=${snippet}` : ''}`
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} returned invalid JSON: ${message}`);
    }
  }

  /** The address we're trading on behalf of (may be different from wallet if using API wallet) */
  get address(): string {
    return this.config.accountAddress;
  }

  /** The address of the signing wallet (derived from private key) */
  get walletAddress(): string {
    return this.config.walletAddress;
  }

  /** Whether we're using an API wallet (signing wallet differs from trading account) */
  get isApiWallet(): boolean {
    return this.config.isApiWallet;
  }

  get builderInfo(): BuilderInfo {
    return {
      b: this.config.builderAddress.toLowerCase(),
      f: this.config.builderFee,
    };
  }

  get builderAddress(): string {
    return this.config.builderAddress;
  }

  get builderFeeBps(): number {
    return this.config.builderFee / 10; // Convert from tenths of bps to bps
  }

  /** Whether client is in read-only mode (no trading capability) */
  get isReadOnly(): boolean {
    return this.config.isReadOnly;
  }

  /** Whether connected to testnet (HIP-3 dexes not auto-loaded) */
  get isTestnet(): boolean {
    return !isMainnet();
  }

  /**
   * Returns vaultAddress param for SDK exchange calls.
   * Only used for vault trading (HYPERLIQUID_VAULT_ADDRESS set explicitly).
   * Standard API wallets (agents) do NOT need this — the API maps agent → master automatically.
   */
  private get vaultParam(): { vaultAddress: `0x${string}` } | Record<string, never> {
    if (this.config.vaultAddress) {
      return { vaultAddress: this.config.vaultAddress as `0x${string}` };
    }
    return {};
  }

  /** Throw error if trying to trade in read-only mode. Validates API wallet on first call. */
  private async requireTrading(): Promise<void> {
    if (this.config.isReadOnly) {
      throw new Error(
        'Trading not available. Run "openbroker setup" to configure your wallet.'
      );
    }
    // One-time API wallet validation on first trade attempt
    if (this.config.isApiWallet && !this.apiWalletValidated) {
      this.apiWalletValidated = true;
      await this.validateApiWalletSetup();
    }
  }

  // ============ Market Data ============

  async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    if (this.meta) return this.meta;

    this.log('Fetching metaAndAssetCtxs...');
    let response;
    try {
      response = await this.withRetry(() => this.info.metaAndAssetCtxs(), 'metaAndAssetCtxs');
    } catch (error) {
      this.log('metaAndAssetCtxs failure context:', this.getTransportContext('metaAndAssetCtxs'));
      if (error instanceof Error && error.stack) {
        this.log('metaAndAssetCtxs stack:', error.stack);
      }
      throw new Error(`metaAndAssetCtxs failed: ${this.describeError(error)}`);
    }
    this.log('metaAndAssetCtxs response:', JSON.stringify(response, null, 2).slice(0, 500) + '...');

    this.meta = {
      meta: { universe: response[0].universe },
      assetCtxs: response[1],
    };

    // Build lookup maps for main dex
    this.meta.meta.universe.forEach((asset, index) => {
      this.assetMap.set(asset.name, index);
      this.szDecimalsMap.set(asset.name, asset.szDecimals);
      this.coinDexMap.set(asset.name, { dexName: null, dexIdx: 0, localName: asset.name });
    });

    // Load HIP-3 dex assets (only once - maps persist across meta cache invalidation)
    if (!this.hip3Loaded) {
      await this.loadHip3Assets();
      this.hip3Loaded = true;
    }

    return this.meta;
  }

  /**
   * Load HIP-3 perp dex assets into the asset/szDecimals maps.
   * Asset index formula: 100000 + dexIdx * 10000 + assetIdx
   * Coins are keyed as "dexName:COIN" (e.g., "xyz:CL")
   */
  /** Max concurrent HIP-3 API requests to avoid rate limiting */
  private static readonly HIP3_CONCURRENCY = 5;

  /**
   * Like Promise.allSettled but with a concurrency limit.
   * Processes tasks in batches to avoid hitting API rate limits.
   */
  private async batchSettled<T>(tasks: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = [];
    const concurrency = HyperliquidClient.HIP3_CONCURRENCY;
    for (let i = 0; i < tasks.length; i += concurrency) {
      const batch = tasks.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(batch.map(fn => fn()));
      results.push(...batchResults);
    }
    return results;
  }

  /**
   * Load HIP-3 perp dex assets into the asset/szDecimals maps.
   * On testnet: skips auto-loading (too many junk dexes). Use loadSingleHip3Dex() on demand.
   * On mainnet: loads all dexes with concurrency limit.
   */
  private async loadHip3Assets(): Promise<void> {
    try {
      const dexs = await this.getPerpDexs();

      // On testnet, skip auto-loading — too many junk dexes cause rate limiting.
      // Users can reference specific dexes (e.g., "felix:BTC") which triggers on-demand loading.
      if (!isMainnet()) {
        const dexCount = dexs.filter(d => d != null).length - 1; // exclude null at index 0
        if (dexCount > 0) {
          this.log(`Testnet: skipping auto-load of ${dexCount} HIP-3 dexes. Use "dexName:COIN" to load a specific dex on demand.`);
        }
        return;
      }

      // Mainnet: load all dexes
      const dexEntries: Array<{ dex: { name: string }; dexIdx: number }> = [];
      for (let dexIdx = 1; dexIdx < dexs.length; dexIdx++) {
        const dex = dexs[dexIdx];
        if (dex) dexEntries.push({ dex, dexIdx });
      }

      const results = await this.batchSettled(
        dexEntries.map(({ dex, dexIdx }) => async () => {
          const data = await this.postInfo<unknown>(
            { type: 'metaAndAssetCtxs', dex: dex.name },
            `metaAndAssetCtxs(${dex.name})`
          );
          return { dex, dexIdx, data };
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          this.log(`Failed to load HIP-3 dex:`, result.reason);
          continue;
        }
        const { dex, dexIdx, data: dexData } = result.value;
        this.registerHip3Dex(dex.name, dexIdx, dexData);
      }
    } catch (e) {
      this.log('Failed to load HIP-3 assets:', e);
    }
  }

  /**
   * Load a single HIP-3 dex by name (on-demand, e.g. when user references "felix:BTC").
   * No-op if already loaded.
   */
  async loadSingleHip3Dex(dexName: string): Promise<boolean> {
    if (this.loadedHip3Dexes.has(dexName)) return true;

    const dexs = await this.getPerpDexs();
    const dexIdx = dexs.findIndex(d => d?.name === dexName);
    if (dexIdx < 1) {
      this.log(`HIP-3 dex "${dexName}" not found in perpDexs list`);
      return false;
    }

    try {
      this.log(`On-demand loading HIP-3 dex: ${dexName}`);
      const data = await this.postInfo<unknown>(
        { type: 'metaAndAssetCtxs', dex: dexName },
        `metaAndAssetCtxs(${dexName})`
      );
      this.registerHip3Dex(dexName, dexIdx, data);
      return true;
    } catch (e) {
      this.log(`Failed to load HIP-3 dex ${dexName}:`, e);
      return false;
    }
  }

  /**
   * Get HIP-3 dexes to iterate over for bulk queries.
   * Mainnet: all dexes. Testnet: only explicitly loaded dexes.
   */
  private async getIterableHip3Dexs(): Promise<Array<{ name: string; fullName: string; deployer: string }>> {
    const dexs = await this.getPerpDexs();
    const all = dexs.slice(1).filter((d): d is NonNullable<typeof d> => d != null);
    if (isMainnet()) return all;
    // Testnet: only return dexes that have been explicitly loaded
    return all.filter(d => this.loadedHip3Dexes.has(d.name));
  }

  /** Register a fetched HIP-3 dex's assets into lookup maps */
  private registerHip3Dex(dexName: string, dexIdx: number, dexData: any): void {
    if (dexData && dexData[0]?.universe) {
      const universe = dexData[0].universe as Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }>;
      this.log(`Loading HIP-3 dex: ${dexName} with ${universe.length} markets`);

      universe.forEach((asset, assetIdx) => {
        const coinName = asset.name;
        const localName = coinName.startsWith(dexName + ':') ? coinName.slice(dexName.length + 1) : coinName;
        const globalIndex = 100000 + dexIdx * 10000 + assetIdx;

        this.assetMap.set(coinName, globalIndex);
        this.szDecimalsMap.set(coinName, asset.szDecimals);
        this.coinDexMap.set(coinName, { dexName, dexIdx, localName });
        if (asset.maxLeverage) this.hip3MaxLeverageMap.set(coinName, asset.maxLeverage);
      });
    }
    this.loadedHip3Dexes.add(dexName);
  }

  async getAllMids(): Promise<Record<string, string>> {
    this.log('Fetching allMids...');
    let response: Record<string, string>;
    try {
      response = await this.withRetry(() => this.info.allMids(), 'allMids') as Record<string, string>;
    } catch (error) {
      this.log('allMids failure context:', this.getTransportContext('allMids'));
      if (error instanceof Error && error.stack) {
        this.log('allMids stack:', error.stack);
      }
      throw new Error(`allMids failed: ${this.describeError(error)}`);
    }

    // Also fetch HIP-3 dex mids (in parallel; testnet: only loaded dexes)
    try {
      const validDexs = await this.getIterableHip3Dexs();
      const results = await this.batchSettled(
        validDexs.map((dex) => async () => {
          const mids = await this.postInfo<Record<string, string>>(
            { type: 'allMids', dex: dex.name },
            `allMids(${dex.name})`
          );
          return { dex, mids };
        })
      );

      for (const result of results) {
        if (result.status === 'rejected') {
          this.log('Failed to fetch HIP-3 dex mids:', result.reason);
          continue;
        }
        for (const [coin, mid] of Object.entries(result.value.mids)) {
          response[coin] = mid;
        }
      }
    } catch (e) {
      this.log('Failed to fetch HIP-3 mids:', e);
    }

    return response;
  }

  /**
   * Get all perpetual DEXs (including HIP-3 builder-deployed markets)
   * Returns array where index 0 is null (main dex), others are HIP-3 dexs
   */
  async getPerpDexs(): Promise<Array<{
    name: string;
    fullName: string;
    deployer: string;
  } | null>> {
    if (this.perpDexsCache) return this.perpDexsCache;

    this.log('Fetching perpDexs...');
    const data = await this.postInfo<Array<{
      name: string;
      fullName: string;
      deployer: string;
    } | null>>({ type: 'perpDexs' }, 'perpDexs');
    this.log('perpDexs response:', JSON.stringify(data).slice(0, 500));
    this.perpDexsCache = data;
    return data;
  }

  /**
   * Get all perp markets including HIP-3 dexs
   * Returns array of [meta, assetCtxs] for each dex
   */
  async getAllPerpMetas(): Promise<Array<{
    dexName: string | null;
    meta: { universe: Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }> };
    assetCtxs: Array<{
      funding: string;
      openInterest: string;
      markPx: string;
      midPx: string | null;
      oraclePx: string;
      prevDayPx: string;
      dayNtlVlm: string;
    }>;
  }>> {
    this.log('Fetching all perp markets...');
    const results: Array<{
      dexName: string | null;
      meta: { universe: Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }> };
      assetCtxs: Array<{
        funding: string;
        openInterest: string;
        markPx: string;
        midPx: string | null;
        oraclePx: string;
        prevDayPx: string;
        dayNtlVlm: string;
      }>;
    }> = [];

    // Get main dex data (no dex parameter)
    const mainData = await this.postInfo<any>({ type: 'metaAndAssetCtxs' }, 'metaAndAssetCtxs(main)');
    this.log('Main dex data fetched');

    results.push({
      dexName: null,
      meta: { universe: mainData[0].universe },
      assetCtxs: mainData[1],
    });

    // Get HIP-3 dex names and fetch all in parallel (testnet: only loaded dexes)
    const validDexs = await this.getIterableHip3Dexs();

    const hip3Results = await this.batchSettled(
      validDexs.map((dex) => async () => {
        const data = await this.postInfo<any>(
          { type: 'metaAndAssetCtxs', dex: dex.name },
          `metaAndAssetCtxs(${dex.name})`
        );
        return { dex, data };
      })
    );

    for (const result of hip3Results) {
      if (result.status === 'rejected') {
        this.log('Failed to fetch HIP-3 dex:', result.reason);
        continue;
      }
      const { dex, data: dexData } = result.value;
      if (dexData && dexData[0]?.universe) {
        this.log(`Fetched HIP-3 dex: ${dex.name} with ${dexData[0].universe.length} markets`);
        results.push({
          dexName: dex.name,
          meta: { universe: dexData[0].universe },
          assetCtxs: dexData[1] || [],
        });
      }
    }

    return results;
  }

  /**
   * Get spot market metadata
   */
  async getSpotMeta(): Promise<{
    tokens: Array<{
      name: string;
      szDecimals: number;
      weiDecimals: number;
      index: number;
      tokenId: string;
      isCanonical: boolean;
      fullName: string | null;
    }>;
    universe: Array<{
      name: string;
      tokens: [number, number];
      index: number;
      isCanonical: boolean;
    }>;
  }> {
    this.log('Fetching spotMeta...');
    const data = await this.postInfo<{
      tokens: Array<{
        name: string;
        szDecimals: number;
        weiDecimals: number;
        index: number;
        tokenId: string;
        isCanonical: boolean;
        fullName: string | null;
      }>;
      universe: Array<{
        name: string;
        tokens: [number, number];
        index: number;
        isCanonical: boolean;
      }>;
    }>({ type: 'spotMeta' }, 'spotMeta');
    this.log('spotMeta response:', JSON.stringify(data).slice(0, 500));
    return data;
  }

  /**
   * Get spot metadata with asset contexts (prices, volumes)
   */
  async getSpotMetaAndAssetCtxs(): Promise<{
    meta: {
      tokens: Array<{
        name: string;
        szDecimals: number;
        weiDecimals: number;
        index: number;
        tokenId: string;
        isCanonical: boolean;
      }>;
      universe: Array<{
        name: string;
        tokens: [number, number];
        index: number;
        isCanonical: boolean;
      }>;
    };
    assetCtxs: Array<{
      coin?: string;
      dayNtlVlm: string;
      markPx: string;
      midPx: string;
      prevDayPx: string;
    }>;
  }> {
    this.log('Fetching spotMetaAndAssetCtxs...');
    const data = await this.postInfo<unknown>(
      { type: 'spotMetaAndAssetCtxs' },
      'spotMetaAndAssetCtxs'
    );
    this.log('spotMetaAndAssetCtxs response:', JSON.stringify(data).slice(0, 500));

    if (!Array.isArray(data) || !data[0] || !data[1]) {
      this.log('spotMetaAndAssetCtxs returned null/malformed data, falling back to spotMeta + allMids');

      const [meta, mids] = await Promise.all([
        this.getSpotMeta(),
        this.getAllMids(),
      ]);

      return {
        meta,
        assetCtxs: meta.universe.map((pair) => {
          const price = mids[pair.name] ?? '0';
          return {
            coin: pair.name,
            dayNtlVlm: '0',
            markPx: price,
            midPx: price,
            prevDayPx: price,
          };
        }),
      };
    }

    return {
      meta: data[0],
      assetCtxs: data[1],
    };
  }

  /**
   * Load spot metadata into lookup maps.
   * Spot asset index for orders = 10000 + universe[i].index
   * Uses the base token's szDecimals for size rounding.
   */
  private async loadSpotMeta(): Promise<void> {
    if (this.spotMetaLoaded) return;

    try {
      const spotData = await this.getSpotMeta();
      // Build token lookup for szDecimals
      const tokenMap = new Map<number, { name: string; szDecimals: number }>();
      for (const token of spotData.tokens) {
        tokenMap.set(token.index, { name: token.name, szDecimals: token.szDecimals });
      }

      for (const pair of spotData.universe) {
        // pair.name is the market name (e.g., "PURR/USDC", "@107")
        // pair.tokens = [baseTokenIndex, quoteTokenIndex]
        // pair.index is the spot universe index
        const baseToken = tokenMap.get(pair.tokens[0]);
        if (!baseToken) continue;

        const spotAssetIndex = 10000 + pair.index;
        const quoteTokenIdx = pair.tokens[1];

        // A token can appear in multiple pairs (e.g., HYPE/USDC, HYPE/USDE, HYPE/USDH).
        // Prefer the USDC pair (quote token index 0) for the primary mapping.
        const existing = this.spotAssetMap.get(baseToken.name);
        if (existing !== undefined && quoteTokenIdx !== 0) {
          // Already have a mapping — skip non-USDC pairs
          continue;
        }

        this.spotAssetMap.set(baseToken.name, spotAssetIndex);
        this.spotPairNameMap.set(baseToken.name, pair.name);
        this.spotSzDecimalsMap.set(baseToken.name, baseToken.szDecimals);

        this.log(
          `Spot: ${baseToken.name} → asset ${spotAssetIndex}, market ${pair.name} (szDecimals: ${baseToken.szDecimals})`
        );
      }

      this.spotMetaLoaded = true;
      this.log(`Loaded ${this.spotAssetMap.size} spot markets`);
    } catch (e) {
      this.log('Failed to load spot metadata:', e);
    }
  }

  /** Get the spot asset index for a coin, or undefined if not a spot asset */
  getSpotAssetIndex(coin: string): number | undefined {
    return this.spotAssetMap.get(coin);
  }

  /** Get the preferred spot market key for a coin (e.g. "@230", "PURR/USDC") */
  getSpotMarketKey(coin: string): string | undefined {
    return this.spotPairNameMap.get(coin);
  }

  /** Get spot szDecimals for a coin */
  getSpotSzDecimals(coin: string): number | undefined {
    return this.spotSzDecimalsMap.get(coin);
  }

  /** Get all loaded spot asset names */
  getSpotAssetNames(): string[] {
    return Array.from(this.spotAssetMap.keys());
  }

  /**
   * Get user's spot token balances
   */
  async getSpotBalances(user?: string): Promise<{
    balances: Array<{
      coin: string;
      token: number;
      hold: string;
      total: string;
      entryNtl: string;
    }>;
  }> {
    this.log('Fetching spotClearinghouseState for:', user ?? this.address);
    const data = await this.postInfo<{
      balances: Array<{
        coin: string;
        token: number;
        hold: string;
        total: string;
        entryNtl: string;
      }>;
    }>({
      type: 'spotClearinghouseState',
      user: user ?? this.address,
    }, 'spotClearinghouseState');
    this.log('spotClearinghouseState response:', JSON.stringify(data).slice(0, 500));
    return data;
  }

  /**
   * Get token details by token ID
   */
  async getTokenDetails(tokenId: string): Promise<{
    name: string;
    maxSupply: string;
    totalSupply: string;
    circulatingSupply: string;
    szDecimals: number;
    weiDecimals: number;
    midPx: string;
    markPx: string;
    prevDayPx: string;
    deployer: string;
    deployTime: string;
  } | null> {
    this.log('Fetching tokenDetails for:', tokenId);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    try {
      const response = await fetch(baseUrl + '/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'tokenDetails',
          tokenId,
        }),
      });
      const data = await response.json();
      this.log('tokenDetails response:', JSON.stringify(data).slice(0, 500));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * Get predicted funding rates across venues
   */
  async getPredictedFundings(): Promise<Array<[
    string, // coin
    Array<[string, { fundingRate: string; nextFundingTime: number }]> // venue funding rates
  ]>> {
    this.log('Fetching predictedFundings...');
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'predictedFundings' }),
    });
    const data = await response.json();
    this.log('predictedFundings response length:', data?.length);
    return data;
  }

  /**
   * Get L2 order book for an asset
   * Returns best bid/ask and depth
   */
  async getL2Book(coin: string): Promise<{
    bids: Array<{ px: string; sz: string; n: number }>;
    asks: Array<{ px: string; sz: string; n: number }>;
    bestBid: number;
    bestAsk: number;
    midPrice: number;
    spread: number;
    spreadBps: number;
  }> {
    this.log('Fetching l2Book for:', coin);
    // API accepts prefixed names directly (e.g., "xyz:CL")
    let response;
    try {
      response = await this.info.l2Book({ coin });
    } catch (error) {
      this.log('l2Book failure context:', this.getTransportContext(`l2Book(${coin})`));
      if (error instanceof Error && error.stack) {
        this.log('l2Book stack:', error.stack);
      }
      throw new Error(`l2Book(${coin}) failed: ${this.describeError(error)}`);
    }

    const bids = response.levels[0] as Array<{ px: string; sz: string; n: number }>;
    const asks = response.levels[1] as Array<{ px: string; sz: string; n: number }>;

    const bestBid = bids.length > 0 ? parseFloat(bids[0].px) : 0;
    const bestAsk = asks.length > 0 ? parseFloat(asks[0].px) : 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 0;

    return {
      bids,
      asks,
      bestBid,
      bestAsk,
      midPrice,
      spread,
      spreadBps,
    };
  }

  async getAssetIndexAsync(coin: string): Promise<number> {
    let index = this.assetMap.get(coin);
    if (index === undefined && coin.includes(':')) {
      // Try on-demand loading the dex (e.g., "felix:BTC" → load "felix")
      const dexName = coin.split(':')[0];
      await this.loadSingleHip3Dex(dexName);
      index = this.assetMap.get(coin);
    }
    if (index === undefined) {
      const hip3Matches = this.findHip3Matches(coin);
      if (hip3Matches.length > 0) {
        const suggestions = hip3Matches.map(m => `${m}`).join(', ');
        throw new Error(
          `Unknown asset: ${coin}. Did you mean one of these HIP-3 assets? ${suggestions}\n` +
          `Use "openbroker search --query ${coin}" to find the full ticker.`
        );
      }
      throw new Error(`Unknown asset: ${coin}. Available: ${Array.from(this.assetMap.keys()).slice(0, 10).join(', ')}...`);
    }
    return index;
  }

  getAssetIndex(coin: string): number {
    const index = this.assetMap.get(coin);
    if (index === undefined) {
      // Check if bare name exists in HIP-3 dexes and suggest prefixed version
      const hip3Matches = this.findHip3Matches(coin);
      if (hip3Matches.length > 0) {
        const suggestions = hip3Matches.map(m => `${m}`).join(', ');
        throw new Error(
          `Unknown asset: ${coin}. Did you mean one of these HIP-3 assets? ${suggestions}\n` +
          `Use "openbroker search --query ${coin}" to find the full ticker.`
        );
      }
      throw new Error(`Unknown asset: ${coin}. Available: ${Array.from(this.assetMap.keys()).slice(0, 10).join(', ')}...`);
    }
    return index;
  }

  async getSzDecimalsAsync(coin: string): Promise<number> {
    let decimals = this.szDecimalsMap.get(coin);
    if (decimals === undefined && coin.includes(':')) {
      const dexName = coin.split(':')[0];
      await this.loadSingleHip3Dex(dexName);
      decimals = this.szDecimalsMap.get(coin);
    }
    if (decimals === undefined) {
      const hip3Matches = this.findHip3Matches(coin);
      if (hip3Matches.length > 0) {
        throw new Error(
          `Unknown asset: ${coin}. Did you mean: ${hip3Matches.join(', ')}?`
        );
      }
      throw new Error(`Unknown asset: ${coin}`);
    }
    return decimals;
  }

  getSzDecimals(coin: string): number {
    const decimals = this.szDecimalsMap.get(coin);
    if (decimals === undefined) {
      const hip3Matches = this.findHip3Matches(coin);
      if (hip3Matches.length > 0) {
        throw new Error(
          `Unknown asset: ${coin}. Did you mean: ${hip3Matches.join(', ')}?`
        );
      }
      throw new Error(`Unknown asset: ${coin}`);
    }
    return decimals;
  }

  /**
   * Find HIP-3 assets matching a bare coin name (without dex prefix)
   */
  private findHip3Matches(bareName: string): string[] {
    const matches: string[] = [];
    const upperName = bareName.toUpperCase();
    for (const [key, info] of this.coinDexMap.entries()) {
      if (info.dexName && info.localName.toUpperCase() === upperName) {
        matches.push(key);
      }
    }
    return matches;
  }

  /**
   * Get the dex name for a coin (null for main dex assets)
   */
  getCoinDex(coin: string): string | null {
    return this.coinDexMap.get(coin)?.dexName ?? null;
  }

  /**
   * Get the local (unprefixed) coin name for API calls that need it
   * e.g., "xyz:CL" → "CL", "ETH" → "ETH"
   */
  getCoinLocalName(coin: string): string {
    return this.coinDexMap.get(coin)?.localName ?? coin;
  }

  /**
   * Check if a coin is a HIP-3 asset
   */
  isHip3(coin: string): boolean {
    return this.coinDexMap.get(coin)?.dexName != null;
  }

  /**
   * Invalidate cached metadata so next call fetches fresh data.
   * Useful for long-running strategies that need updated funding rates.
   */
  invalidateMetaCache(): void {
    this.meta = null;
    // Keep the asset/szDecimals/coinDex maps - they don't change
  }

  /**
   * Get all loaded asset names (main + HIP-3)
   */
  getAllAssetNames(): string[] {
    return Array.from(this.assetMap.keys());
  }

  /**
   * Get all HIP-3 asset names
   */
  getHip3AssetNames(): string[] {
    return Array.from(this.coinDexMap.entries())
      .filter(([_, info]) => info.dexName !== null)
      .map(([name]) => name);
  }

  // ============ Account Info ============

  /**
   * Get the account's abstraction mode.
   * Returns: 'standard' | 'unified' | 'portfolio' | 'dexAbstraction'
   * Unified accounts have a single USDC balance shared across all dexes.
   * Standard accounts have separate balances per dex (need sendAsset transfers).
   */
  async getAccountMode(user?: string): Promise<string> {
    if (this.accountMode) return this.accountMode;

    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    try {
      const response = await fetch(baseUrl + '/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'userAbstraction',
          user: user ?? this.address,
        }),
      });
      const data = await response.json();
      this.log('userAbstraction response:', JSON.stringify(data));

      // API may return a bare string or an object. Normalize to string for matching.
      const mode = typeof data === 'string' ? data : (data?.abstraction ?? data?.mode ?? String(data));
      const modeLower = mode.toLowerCase();

      if (modeLower.includes('unified')) {
        this.accountMode = 'unified';
      } else if (modeLower.includes('portfolio')) {
        this.accountMode = 'portfolio';
      } else if (modeLower.includes('dex')) {
        this.accountMode = 'dexAbstraction';
      } else {
        // "default" or "disabled" both mean standard mode
        this.accountMode = 'standard';
      }
    } catch (err) {
      this.log('Failed to fetch account abstraction mode:', err instanceof Error ? err.message : String(err));
      this.accountMode = 'standard'; // Safe fallback
    }

    this.log('Account mode:', this.accountMode);
    return this.accountMode;
  }

  /** Whether the account uses unified balances (unified or portfolio margin) */
  async isUnifiedAccount(user?: string): Promise<boolean> {
    const mode = await this.getAccountMode(user);
    return mode === 'unified' || mode === 'portfolio';
  }

  /**
   * Query the role of an address on HyperCore L1.
   * Returns: "user" | "agent" | "vault" | "subAccount" | "missing"
   * Useful for verifying API wallet (agent) registration.
   */
  async getUserRole(address?: string): Promise<{ role: string; data?: Record<string, string> }> {
    const target = address ?? this.address;
    this.log('Fetching userRole for:', target);
    try {
      const response = await this.postInfo<{ role: string; data?: Record<string, string> }>(
        { type: 'userRole', user: target },
        'userRole'
      );
      this.log('userRole response:', JSON.stringify(response));
      return response ?? { role: 'missing' };
    } catch (e) {
      this.log('userRole query failed:', e);
      return { role: 'unknown' };
    }
  }

  /**
   * Validate API wallet setup: check that the signing wallet is recognized
   * as an "agent" on HyperCore and the account address exists.
   * Logs warnings if misconfigured.
   */
  async validateApiWalletSetup(): Promise<{ valid: boolean; walletRole: string; accountRole: string }> {
    const walletResult = await this.getUserRole(this.walletAddress);
    const accountResult = await this.getUserRole(this.address);
    const walletRole = walletResult.role;
    const accountRole = accountResult.role;

    this.log(`API wallet validation: wallet ${this.walletAddress} role=${walletRole}, account ${this.address} role=${accountRole}`);

    if (walletRole === 'agent') {
      const masterAddress = walletResult.data?.user;
      if (masterAddress && masterAddress.toLowerCase() !== this.address.toLowerCase()) {
        console.warn(
          `\x1b[33m⚠️  API wallet ${this.walletAddress} is an agent for ${masterAddress}, but HYPERLIQUID_ACCOUNT_ADDRESS is ${this.address}.\n` +
          `   These should match.\x1b[0m`
        );
      } else {
        this.log(`API wallet confirmed as agent for ${masterAddress ?? this.address}`);
      }
    } else {
      console.warn(
        `\x1b[33m⚠️  API wallet ${this.walletAddress} has role "${walletRole}" on HyperCore (expected "agent").\n` +
        `   Make sure the agent is registered via CoreWriter.registerAgent() on the correct network (${isMainnet() ? 'mainnet' : 'testnet'}).\x1b[0m`
      );
    }

    if (accountRole === 'missing') {
      console.warn(
        `\x1b[33m⚠️  Account ${this.address} has role "missing" on HyperCore.\n` +
        `   The account may not exist on ${isMainnet() ? 'mainnet' : 'testnet'} yet. Ensure the contract is deployed and has interacted with HyperCore.\x1b[0m`
      );
    }

    return { valid: walletRole === 'agent', walletRole, accountRole };
  }

  /**
   * Check if an address has sub-accounts (is a master account)
   * Sub-accounts cannot approve builder fees - only master accounts can
   */
  async getSubAccounts(user?: string): Promise<Array<{ subAccountUser: string; name: string }>> {
    this.log('Fetching subAccounts for:', user ?? this.address);
    try {
      const response = await this.info.subAccounts({ user: user ?? this.address });
      if (!response) return [];
      // Response is an array of sub-account objects
      return response.map((sub: { subAccountUser: string; name: string }) => ({
        subAccountUser: sub.subAccountUser,
        name: sub.name,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Check the maximum builder fee approved for a user/builder pair
   * Returns the max fee rate as a string (e.g., "0.1%") or null if not approved
   */
  async getMaxBuilderFee(user?: string, builder?: string): Promise<string | null> {
    // IMPORTANT: Hyperliquid API requires lowercase addresses
    const targetUser = (user ?? this.address).toLowerCase();
    const targetBuilder = (builder ?? this.config.builderAddress).toLowerCase();

    this.log('Fetching maxBuilderFee for:', targetUser, 'builder:', targetBuilder);

    try {
      const baseUrl = isMainnet()
        ? 'https://api.hyperliquid.xyz'
        : 'https://api.hyperliquid-testnet.xyz';

      const response = await fetch(baseUrl + '/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'maxBuilderFee',
          user: targetUser,
          builder: targetBuilder,
        }),
      });
      const data = await response.json();
      this.log('maxBuilderFee response:', data);

      // API returns a number (fee in tenths of bps) or 0/null if not approved
      // e.g., 100 = 10 bps = 0.1%
      if (data !== null && data !== undefined && data !== 0) {
        // Convert from tenths of bps to percentage string
        const bps = Number(data) / 10;
        const pct = bps / 100;
        return `${pct}%`;
      }
      return null;
    } catch (error) {
      this.log('maxBuilderFee error:', error);
      return null;
    }
  }

  /**
   * Approve a builder fee for the open-broker builder
   * IMPORTANT: This must be signed by a MAIN wallet, not an API wallet or sub-account
   *
   * @param maxFeeRate - Max fee rate to approve (e.g., "0.01%" for 1 bps)
   * @param builder - Builder address (defaults to open-broker builder)
   */
  async approveBuilderFee(
    maxFeeRate: string = '0.1%',
    builder?: string
  ): Promise<{ status: 'ok' | 'err'; response?: unknown }> {
    const targetBuilder = builder ?? this.config.builderAddress;

    this.log('Approving builder fee:', maxFeeRate, 'for builder:', targetBuilder);

    // Check if using API wallet - this won't work
    if (this.isApiWallet) {
      return {
        status: 'err',
        response: 'Cannot approve builder fee with API wallet. Must use main wallet private key.',
      };
    }

    try {
      const response = await this.exchange.approveBuilderFee({
        builder: targetBuilder as `0x${string}`,
        maxFeeRate,
      }, this.vaultParam);
      this.log('approveBuilderFee response:', response);
      return { status: 'ok', response };
    } catch (error) {
      this.log('approveBuilderFee error:', error);
      return {
        status: 'err',
        response: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get user funding ledger updates
   * Returns array of funding payments received/paid per position
   */
  async getUserFunding(user?: string, startTime?: number, endTime?: number): Promise<Array<{
    time: number;
    hash: string;
    delta: {
      type: 'funding';
      coin: string;
      usdc: string;
      szi: string;
      fundingRate: string;
      nSamples: number | null;
    };
  }>> {
    this.log('Fetching userFunding for:', user ?? this.address);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const body: Record<string, unknown> = {
      type: 'userFunding',
      user: user ?? this.address,
    };
    if (startTime !== undefined) body.startTime = startTime;
    if (endTime !== undefined) body.endTime = endTime;

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    this.log('userFunding response length:', data?.length);
    return data;
  }

  /**
   * Get user trade fills
   */
  async getUserFills(user?: string, aggregateByTime?: boolean): Promise<Array<{
    coin: string;
    px: string;
    sz: string;
    side: 'B' | 'A';
    time: number;
    startPosition: string;
    dir: string;
    closedPnl: string;
    fee: string;
    hash: string;
    oid: number;
    tid: number;
    crossed: boolean;
    feeToken: string;
    twapId: number | null;
    cloid: string | null;
    builderFee: string | null;
  }>> {
    this.log('Fetching userFills for:', user ?? this.address);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const body: Record<string, unknown> = {
      type: 'userFills',
      user: user ?? this.address,
    };
    if (aggregateByTime !== undefined) body.aggregateByTime = aggregateByTime;

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    this.log('userFills response length:', data?.length);
    return data;
  }

  /**
   * Get historical orders (all statuses)
   */
  async getHistoricalOrders(user?: string): Promise<Array<{
    order: {
      coin: string;
      side: string;
      limitPx: string;
      sz: string;
      origSz: string;
      oid: number;
      timestamp: number;
      orderType: string;
      tif: string | null;
      cloid: string | null;
      triggerCondition: string;
      triggerPx: string;
      isTrigger: boolean;
      isPositionTpsl: boolean;
      reduceOnly: boolean;
      children: unknown[];
    };
    status: string;
    statusTimestamp: number;
  }>> {
    this.log('Fetching historicalOrders for:', user ?? this.address);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'historicalOrders',
        user: user ?? this.address,
      }),
    });
    const data = await response.json();
    this.log('historicalOrders response length:', data?.length);
    return data;
  }

  /**
   * Get status of a specific order by OID or CLOID
   */
  async getOrderStatus(oid: number | string, user?: string): Promise<{
    status: string;
    order?: {
      order: {
        coin: string;
        side: string;
        limitPx: string;
        sz: string;
        origSz: string;
        oid: number;
        timestamp: number;
        orderType: string;
        tif: string | null;
        cloid: string | null;
        triggerCondition: string;
        triggerPx: string;
        isTrigger: boolean;
        isPositionTpsl: boolean;
        reduceOnly: boolean;
      };
      status: string;
      statusTimestamp: number;
    };
  }> {
    this.log('Fetching orderStatus for oid:', oid);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'orderStatus',
        user: user ?? this.address,
        oid: typeof oid === 'string' ? oid : oid,
      }),
    });
    const data = await response.json();
    this.log('orderStatus response:', JSON.stringify(data).slice(0, 500));
    return data;
  }

  /**
   * Get user fee schedule and volume info
   */
  async getUserFees(user?: string): Promise<{
    dailyUserVlm: Array<{ date: string; exchange: string; userCross: string; userAdd: string }>;
    feeSchedule: Record<string, unknown>;
    userCrossRate: string;
    userAddRate: string;
    userSpotCrossRate: string;
    userSpotAddRate: string;
    activeReferralDiscount: string;
    trial: unknown;
    feeTrialEscrow: string;
    nextTrialAvailableTimestamp: unknown;
    stakingLink: { stakingUser: string; status: string } | null;
    activeStakingDiscount: { basisPoints: number; discountRate: string } | null;
  }> {
    this.log('Fetching userFees for:', user ?? this.address);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userFees',
        user: user ?? this.address,
      }),
    });
    const data = await response.json();
    this.log('userFees response:', JSON.stringify(data).slice(0, 500));
    return data;
  }

  /**
   * Get OHLCV candle data for an asset
   */
  async getCandleSnapshot(
    coin: string,
    interval: string,
    startTime: number,
    endTime?: number
  ): Promise<Array<{
    t: number;
    T: number;
    s: string;
    i: string;
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    n: number;
  }>> {
    this.log('Fetching candleSnapshot for:', coin, interval);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    // API accepts prefixed names directly (e.g., "xyz:CL")
    const req: Record<string, unknown> = { coin, interval, startTime };
    if (endTime !== undefined) req.endTime = endTime;

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req }),
    });
    const data = await response.json();
    this.log('candleSnapshot response length:', data?.length);
    return data;
  }

  /**
   * Get historical funding rates for an asset
   */
  async getFundingHistory(
    coin: string,
    startTime: number,
    endTime?: number
  ): Promise<Array<{
    coin: string;
    fundingRate: string;
    premium: string;
    time: number;
  }>> {
    this.log('Fetching fundingHistory for:', coin);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    // API accepts prefixed names directly (e.g., "xyz:CL")
    const body: Record<string, unknown> = { type: 'fundingHistory', coin, startTime };
    if (endTime !== undefined) body.endTime = endTime;

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    this.log('fundingHistory response length:', data?.length);
    return data;
  }

  /**
   * Get recent trades for an asset
   */
  async getRecentTrades(coin: string): Promise<Array<{
    coin: string;
    side: 'B' | 'A';
    px: string;
    sz: string;
    time: number;
    hash: string;
    tid: number;
  }>> {
    this.log('Fetching recentTrades for:', coin);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    // API accepts prefixed names directly (e.g., "xyz:CL")
    const body: Record<string, unknown> = { type: 'recentTrades', coin };

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    this.log('recentTrades response length:', data?.length);
    return data;
  }

  /**
   * Get user API rate limit status
   */
  async getUserRateLimit(user?: string): Promise<{
    cumVlm: string;
    nRequestsUsed: number;
    nRequestsCap: number;
    nRequestsSurplus: number;
  }> {
    this.log('Fetching userRateLimit for:', user ?? this.address);
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'userRateLimit',
        user: user ?? this.address,
      }),
    });
    const data = await response.json();
    this.log('userRateLimit response:', JSON.stringify(data));
    return data;
  }

  async getUserState(user?: string, dex?: string): Promise<ClearinghouseState> {
    this.log('Fetching clearinghouseState for:', user ?? this.address, dex ? `dex: ${dex}` : '');
    const params: { user: string; dex?: string } = { user: user ?? this.address };
    if (dex !== undefined) params.dex = dex;
    const label = dex ? `clearinghouseState(${dex})` : 'clearinghouseState(main)';
    let response;
    try {
      response = await this.withRetry(() => this.info.clearinghouseState(params as any), label);
    } catch (error) {
      this.log(`${label} failure context:`, this.getTransportContext(label));
      if (error instanceof Error && error.stack) {
        this.log(`${label} stack:`, error.stack);
      }
      throw new Error(`${label} failed: ${this.describeError(error)}`);
    }

    // The SDK response has `withdrawable` as a top-level field, not inside
    // marginSummary/crossMarginSummary. Copy it into our MarginSummary shape.
    const state = response as unknown as ClearinghouseState;
    const withdrawable = (response as any).withdrawable ?? '0';
    if (state.marginSummary) {
      state.marginSummary.withdrawable = withdrawable;
    }
    if (state.crossMarginSummary) {
      state.crossMarginSummary.withdrawable = withdrawable;
    }
    return state;
  }

  /**
   * Get user state across all dexes (main + HIP-3).
   * For unified accounts: equity comes from spotClearinghouseState (single USDC balance).
   * For standard accounts: aggregates margin summaries from each dex.
   */
  async getUserStateAll(user?: string): Promise<ClearinghouseState> {
    await this.getMetaAndAssetCtxs(); // Ensure HIP-3 dex list is loaded

    const unified = await this.isUnifiedAccount(user);
    const mainState = await this.getUserState(user);

    // Collect positions from all HIP-3 dexes (in parallel; testnet: only loaded dexes)
    const validDexs = await this.getIterableHip3Dexs();
    const dexResults = await this.batchSettled(
      validDexs.map((dex) => async () => {
        const dexState = await this.getUserState(user, dex.name);
        return { dex, dexState };
      })
    );

    let hip3Errors = 0;
    const safeAdd = (a: string | undefined, b: string | undefined): string => {
      const va = parseFloat(a ?? '0') || 0;
      const vb = parseFloat(b ?? '0') || 0;
      return String(va + vb);
    };

    for (const result of dexResults) {
      if (result.status === 'rejected') {
        hip3Errors++;
        this.log(`Failed to fetch state for HIP-3 dex:`, result.reason instanceof Error ? result.reason.message : String(result.reason));
        continue;
      }
      const { dexState } = result.value;
      if (dexState.assetPositions?.length > 0) {
        mainState.assetPositions.push(...dexState.assetPositions);
      }

      // For standard accounts, aggregate margin from each dex
      if (!unified) {
        const dexMargin = dexState.marginSummary;
        if (dexMargin) {
          const addToSummary = (summary: { accountValue: string; totalNtlPos: string; totalRawUsd: string; totalMarginUsed: string; withdrawable: string }) => {
            summary.accountValue = safeAdd(summary.accountValue, dexMargin.accountValue);
            summary.totalNtlPos = safeAdd(summary.totalNtlPos, dexMargin.totalNtlPos);
            summary.totalRawUsd = safeAdd(summary.totalRawUsd, dexMargin.totalRawUsd);
            summary.totalMarginUsed = safeAdd(summary.totalMarginUsed, dexMargin.totalMarginUsed);
            summary.withdrawable = safeAdd(summary.withdrawable, dexMargin.withdrawable);
          };
          addToSummary(mainState.marginSummary);
          addToSummary(mainState.crossMarginSummary);
        }
      }
    }

    if (hip3Errors > 0) {
      this.log(`Warning: ${hip3Errors} HIP-3 dex queries failed — some positions may be missing. Use --verbose for details.`);
    }

    // For unified accounts: equity is the USDC balance from spot clearinghouse
    if (unified) {
      try {
        const spotState = await this.getSpotBalances(user);
        this.log('Unified spot balances:', JSON.stringify(spotState));

        // Find USDC balance (case-insensitive, handles variations)
        const balances = spotState?.balances ?? [];
        const usdcBalance = balances.find(b => b.coin?.toUpperCase() === 'USDC');

        if (usdcBalance) {
          const totalUsdc = usdcBalance.total;
          const holdUsdc = usdcBalance.hold;
          const withdrawable = String(parseFloat(totalUsdc) - parseFloat(holdUsdc));

          // Compute total margin used and notional from all positions
          let totalMarginUsed = 0;
          let totalNtlPos = 0;
          for (const ap of mainState.assetPositions) {
            const pos = ap.position;
            if (parseFloat(pos.szi) === 0) continue;
            totalMarginUsed += parseFloat(pos.marginUsed);
            totalNtlPos += Math.abs(parseFloat(pos.positionValue));
          }

          const summary = {
            accountValue: totalUsdc,
            totalNtlPos: String(totalNtlPos),
            totalRawUsd: totalUsdc,
            totalMarginUsed: String(totalMarginUsed),
            withdrawable,
          };
          mainState.marginSummary = summary;
          mainState.crossMarginSummary = { ...summary };

          this.log(`Unified account: USDC balance $${parseFloat(totalUsdc).toFixed(2)}, margin used $${totalMarginUsed.toFixed(2)}`);
        } else {
          this.log('Unified account: no USDC balance found in spot state. Balances:', balances.map(b => b.coin));
        }
      } catch (err) {
        this.log('Failed to fetch spot balances for unified account:', err instanceof Error ? err.message : String(err));
      }
    }

    return mainState;
  }

  async getOpenOrders(user?: string): Promise<OpenOrder[]> {
    this.log('Fetching openOrders for:', user ?? this.address);
    await this.getMetaAndAssetCtxs(); // Ensure HIP-3 dex list is loaded

    // Fetch main dex orders
    const orders = await this.withRetry(() => this.info.openOrders({ user: user ?? this.address }), 'openOrders') as OpenOrder[];

    // Fetch HIP-3 dex orders (in parallel; testnet: only loaded dexes)
    const validDexs = await this.getIterableHip3Dexs();
    const dexResults = await this.batchSettled(
      validDexs.map((dex) => async () => {
        const dexOrders = await this.info.openOrders({ user: user ?? this.address, dex: dex.name }) as OpenOrder[];
        return { dex, dexOrders };
      })
    );

    for (const result of dexResults) {
      if (result.status === 'rejected') {
        this.log('Failed to fetch open orders for HIP-3 dex:', result.reason instanceof Error ? result.reason.message : String(result.reason));
        continue;
      }
      const { dex, dexOrders } = result.value;
      if (dexOrders.length > 0) {
        this.log(`Found ${dexOrders.length} open orders on HIP-3 dex ${dex.name}`);
        orders.push(...dexOrders);
      }
    }

    return orders;
  }

  // ============ Trading ============

  /**
   * HIP-3 perps: prepare for trading.
   * 1. Set isolated margin mode (required for HIP-3)
   * 2. For standard accounts only: transfer USDC from main perp to HIP-3 dex
   *    (unified accounts share USDC across all dexes automatically)
   */
  private async ensureHip3Ready(coin: string, notional: number, leverage?: number): Promise<void> {
    if (!this.isHip3(coin)) return;

    const dexInfo = this.coinDexMap.get(coin);
    if (!dexInfo?.dexName) return;

    const maxLev = this.hip3MaxLeverageMap.get(coin) ?? 10;
    const effectiveLev = Math.min(leverage ?? maxLev, maxLev);

    // Set isolated margin on first order per asset, or when leverage changes
    if (!this.hip3IsolatedSet.has(coin) || leverage) {
      this.log(`HIP-3 asset ${coin} (dex: ${dexInfo.dexName}) — setting isolated margin at ${effectiveLev}x`);
      try {
        await this.updateLeverage(coin, effectiveLev, false); // false = isolated
        this.hip3IsolatedSet.add(coin);
      } catch (err) {
        this.log(`Failed to set isolated margin for ${coin}:`, err instanceof Error ? err.message : String(err));
        this.hip3IsolatedSet.add(coin);
      }
    }

    // Unified accounts share USDC across all dexes — no transfer needed
    const unified = await this.isUnifiedAccount();
    if (unified) {
      this.log(`Unified account — skipping USDC transfer for ${coin} (shared balance)`);
      return;
    }

    // Standard accounts: transfer USDC to the HIP-3 dex to cover margin
    const requiredMargin = notional / effectiveLev;
    // Add 20% buffer for fees and slippage
    const transferAmount = Math.ceil(requiredMargin * 1.2 * 100) / 100;

    this.log(`HIP-3 margin transfer: ${transferAmount} USDC from main → ${dexInfo.dexName} (notional: ${notional}, leverage: ${effectiveLev}x)`);
    try {
      await this.exchange.sendAsset({
        destination: this.address as `0x${string}`,
        sourceDex: '',            // main perp dex
        destinationDex: dexInfo.dexName,
        token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
        amount: String(transferAmount),
      }, this.vaultParam as any);
      this.log(`Transferred ${transferAmount} USDC to ${dexInfo.dexName} dex`);
    } catch (err) {
      // Log but don't block — dex may already have sufficient balance
      this.log(`Margin transfer to ${dexInfo.dexName} failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  async order(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    orderType: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } },
    reduceOnly: boolean = false,
    includeBuilder: boolean = true,
    leverage?: number
  ): Promise<OrderResponse> {
    await this.requireTrading();
    await this.getMetaAndAssetCtxs();

    // Set leverage if specified (for main perps, cross margin; for HIP-3, handled in ensureHip3Ready)
    if (leverage && !this.isHip3(coin)) {
      this.log(`Setting leverage for ${coin} to ${leverage}x cross`);
      await this.updateLeverage(coin, leverage, true);
    }

    // HIP-3 perps: set isolated margin + transfer USDC to dex
    await this.ensureHip3Ready(coin, size * price, leverage);

    const assetIndex = this.getAssetIndex(coin);
    const szDecimals = this.getSzDecimals(coin);

    const orderWire = {
      a: assetIndex,
      b: isBuy,
      p: roundPrice(price, szDecimals),
      s: roundSize(size, szDecimals),
      r: reduceOnly,
      t: orderType,
    };

    this.log('Placing order:', JSON.stringify(orderWire, null, 2));

    const orderRequest: {
      orders: typeof orderWire[];
      grouping: 'na';
      builder?: BuilderInfo;
    } = {
      orders: [orderWire],
      grouping: 'na',
    };

    // Add builder fee if configured (skip on testnet — builder may not be approved)
    if (includeBuilder && !this.isTestnet && this.config.builderAddress !== '0x0000000000000000000000000000000000000000') {
      orderRequest.builder = this.builderInfo;
      this.log('Including builder fee:', this.builderInfo);
    }

    try {
      const response = await this.exchange.order(orderRequest, this.vaultParam);
      this.log('Order response:', JSON.stringify(response, null, 2));
      return response as unknown as OrderResponse;
    } catch (error) {
      this.log('Order error:', error);
      // Return error in our format
      return {
        status: 'err',
        response: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async marketOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    slippageBps?: number,
    leverage?: number
  ): Promise<OrderResponse> {
    await this.getMetaAndAssetCtxs();

    // Get current mid price
    const mids = await this.getAllMids();
    const midPrice = parseFloat(mids[coin]);
    if (!midPrice) {
      throw new Error(`No mid price for ${coin}. Check if the asset exists.`);
    }

    // Calculate slippage price
    const slippage = (slippageBps ?? this.config.slippageBps) / 10000;
    const limitPrice = isBuy
      ? midPrice * (1 + slippage)
      : midPrice * (1 - slippage);

    this.log(`Market order: ${coin} ${isBuy ? 'BUY' : 'SELL'} ${size} @ ${limitPrice} (mid: ${midPrice}, slippage: ${slippage * 100}%)`);

    return this.order(
      coin,
      isBuy,
      size,
      limitPrice,
      { limit: { tif: 'Ioc' } },
      false,
      true,
      leverage
    );
  }

  async limitOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    tif: 'Gtc' | 'Ioc' | 'Alo' = 'Gtc',
    reduceOnly: boolean = false,
    leverage?: number
  ): Promise<OrderResponse> {
    return this.order(
      coin,
      isBuy,
      size,
      price,
      { limit: { tif } },
      reduceOnly,
      true,
      leverage
    );
  }

  /**
   * Place a trigger order (stop loss or take profit)
   * @param coin - Asset to trade
   * @param isBuy - True for buy, false for sell
   * @param size - Order size
   * @param triggerPrice - Price at which the order triggers
   * @param limitPrice - Limit price for the order (use triggerPrice for market-like execution)
   * @param tpsl - 'tp' for take profit, 'sl' for stop loss
   * @param reduceOnly - Whether order is reduce-only (should be true for TP/SL)
   */
  async triggerOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    triggerPrice: number,
    limitPrice: number,
    tpsl: 'tp' | 'sl',
    reduceOnly: boolean = true,
    leverage?: number
  ): Promise<OrderResponse> {
    await this.requireTrading();
    await this.getMetaAndAssetCtxs();

    // Set leverage if specified (for main perps)
    if (leverage && !this.isHip3(coin)) {
      this.log(`Setting leverage for ${coin} to ${leverage}x cross`);
      await this.updateLeverage(coin, leverage, true);
    }

    // HIP-3 perps: set isolated margin + transfer USDC to dex
    await this.ensureHip3Ready(coin, size * limitPrice, leverage);

    const assetIndex = this.getAssetIndex(coin);
    const szDecimals = this.getSzDecimals(coin);

    // For trigger orders, we use the trigger order type
    // isMarket: false means it becomes a limit order at limitPrice when triggered
    // For stop loss, we typically want some slippage protection
    const orderWire = {
      a: assetIndex,
      b: isBuy,
      p: roundPrice(limitPrice, szDecimals),
      s: roundSize(size, szDecimals),
      r: reduceOnly,
      t: {
        trigger: {
          triggerPx: roundPrice(triggerPrice, szDecimals),
          isMarket: false,
          tpsl,
        },
      },
    };

    this.log('Placing trigger order:', JSON.stringify(orderWire, null, 2));

    const orderRequest: {
      orders: typeof orderWire[];
      grouping: 'na';
      builder?: BuilderInfo;
    } = {
      orders: [orderWire],
      grouping: 'na',
    };

    // Add builder fee if configured (skip on testnet — builder may not be approved)
    if (!this.isTestnet && this.config.builderAddress !== '0x0000000000000000000000000000000000000000') {
      orderRequest.builder = this.builderInfo;
      this.log('Including builder fee:', this.builderInfo);
    }

    try {
      const response = await this.exchange.order(orderRequest, this.vaultParam);
      this.log('Trigger order response:', JSON.stringify(response, null, 2));
      return response as unknown as OrderResponse;
    } catch (error) {
      this.log('Trigger order error:', error);
      return {
        status: 'err',
        response: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Place a stop loss order
   */
  async stopLoss(
    coin: string,
    isBuy: boolean,
    size: number,
    triggerPrice: number,
    slippageBps: number = 100 // 1% slippage for SL execution
  ): Promise<OrderResponse> {
    // For stop loss, limit price should be worse than trigger to ensure fill
    // Buy SL: limit above trigger, Sell SL: limit below trigger
    const slippageMult = slippageBps / 10000;
    const limitPrice = isBuy
      ? triggerPrice * (1 + slippageMult)
      : triggerPrice * (1 - slippageMult);

    return this.triggerOrder(coin, isBuy, size, triggerPrice, limitPrice, 'sl', true);
  }

  /**
   * Place a take profit order
   */
  async takeProfit(
    coin: string,
    isBuy: boolean,
    size: number,
    triggerPrice: number
  ): Promise<OrderResponse> {
    // For take profit, we can use the same price as trigger (it's a favorable price)
    return this.triggerOrder(coin, isBuy, size, triggerPrice, triggerPrice, 'tp', true);
  }

  async cancel(coin: string, oid: number): Promise<CancelResponse> {
    await this.requireTrading();
    await this.getMetaAndAssetCtxs();

    const assetIndex = this.getAssetIndex(coin);

    this.log(`Cancelling order: ${coin} (asset ${assetIndex}) oid ${oid}`);

    try {
      const response = await this.exchange.cancel({
        cancels: [{ a: assetIndex, o: oid }],
      }, this.vaultParam);
      this.log('Cancel response:', JSON.stringify(response, null, 2));
      return response as unknown as CancelResponse;
    } catch (error) {
      this.log('Cancel error:', error);
      return {
        status: 'err',
        response: { type: 'cancel', data: { statuses: [error instanceof Error ? error.message : String(error)] } },
      };
    }
  }

  async cancelAll(coin?: string): Promise<CancelResponse[]> {
    const orders = await this.getOpenOrders();
    const results: CancelResponse[] = [];

    for (const order of orders) {
      if (coin && order.coin !== coin) continue;
      const result = await this.cancel(order.coin, order.oid);
      results.push(result);
    }

    return results;
  }

  // ============ Spot Trading ============

  /**
   * Place a spot order.
   * Uses the same exchange.order() endpoint but with spot asset indices (10000 + spotIndex).
   * Spot orders have no leverage, no reduce-only, and builder fee max is 1000 (vs 100 for perps).
   *
   * @param coin - Base token symbol (e.g. "PURR", "HYPE")
   * @param isBuy - True to buy base token, false to sell
   * @param size - Size in base token units
   * @param price - Limit price in quote token (usually USDC)
   * @param orderType - Order type with time-in-force
   * @param includeBuilder - Whether to include builder fee (default: true)
   */
  async spotOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    orderType: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } },
    includeBuilder: boolean = true,
  ): Promise<OrderResponse> {
    await this.requireTrading();
    await this.loadSpotMeta();

    const assetIndex = this.spotAssetMap.get(coin);
    if (assetIndex === undefined) {
      throw new Error(
        `Unknown spot asset: ${coin}. Available: ${Array.from(this.spotAssetMap.keys()).slice(0, 15).join(', ')}...\n` +
        `Use "openbroker spot" to see all spot markets.`
      );
    }

    const szDecimals = this.spotSzDecimalsMap.get(coin)!;

    const orderWire = {
      a: assetIndex,
      b: isBuy,
      p: roundPrice(price, szDecimals, true),
      s: roundSize(size, szDecimals),
      r: false, // reduce-only not applicable for spot
      t: orderType,
    };

    this.log('Placing spot order:', JSON.stringify(orderWire, null, 2));

    const orderRequest: {
      orders: typeof orderWire[];
      grouping: 'na';
      builder?: BuilderInfo;
    } = {
      orders: [orderWire],
      grouping: 'na',
    };

    // Add builder fee if configured (skip on testnet — builder may not be approved)
    if (includeBuilder && !this.isTestnet && this.config.builderAddress !== '0x0000000000000000000000000000000000000000') {
      orderRequest.builder = this.builderInfo;
      this.log('Including builder fee:', this.builderInfo);
    }

    try {
      const response = await this.exchange.order(orderRequest, this.vaultParam);
      this.log('Spot order response:', JSON.stringify(response, null, 2));
      return response as unknown as OrderResponse;
    } catch (error) {
      this.log('Spot order error:', error);
      return {
        status: 'err',
        response: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Place a spot market order (IOC at slippage price).
   * @param coin - Base token symbol (e.g. "PURR", "HYPE")
   * @param isBuy - True to buy, false to sell
   * @param size - Size in base token units
   * @param slippageBps - Slippage tolerance in basis points (default: config value)
   */
  async spotMarketOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    slippageBps?: number,
  ): Promise<OrderResponse> {
    await this.loadSpotMeta();

    const assetIndex = this.spotAssetMap.get(coin);
    const spotCoinKey = this.spotPairNameMap.get(coin);
    if (assetIndex === undefined || !spotCoinKey) {
      throw new Error(`Unknown spot asset: ${coin}. Use "openbroker spot" to see available markets.`);
    }

    // Use the exact spot market key from spotMeta (e.g. "@230", "PURR/USDC").
    // On testnet the tradable asset id and displayed market key can diverge.
    const mids = await this.getAllMids();
    let midStr = mids[spotCoinKey];

    // Fallback: allMids may omit spot pairs (especially on testnet).
    // Try spotMetaAndAssetCtxs which returns markPx directly.
    if (!midStr) {
      this.log(`allMids missing spot key "${spotCoinKey}", falling back to spotMetaAndAssetCtxs`);
      try {
        const spotData = await this.getSpotMetaAndAssetCtxs();
        const ctxMap = new Map<string, string>();
        for (const ctx of spotData.assetCtxs as Array<{ coin?: string; midPx?: string; markPx: string }>) {
          if (ctx.coin) ctxMap.set(ctx.coin, ctx.midPx || ctx.markPx);
        }
        midStr = ctxMap.get(spotCoinKey);
      } catch (e) {
        this.log(`spotMetaAndAssetCtxs fallback failed:`, e);
      }
    }

    const midPrice = midStr ? parseFloat(midStr) : 0;

    if (!midPrice || midPrice === 0) {
      throw new Error(`No spot price for ${coin} (${spotCoinKey}). Check if the spot market exists with "openbroker spot --coin ${coin}".`);
    }

    // Calculate slippage price
    const slippage = (slippageBps ?? this.config.slippageBps) / 10000;
    const limitPrice = isBuy
      ? midPrice * (1 + slippage)
      : midPrice * (1 - slippage);

    this.log(`Spot market order: ${coin} ${isBuy ? 'BUY' : 'SELL'} ${size} @ ${limitPrice} (mid: ${midPrice}, slippage: ${slippage * 100}%)`);

    return this.spotOrder(
      coin,
      isBuy,
      size,
      limitPrice,
      { limit: { tif: 'Ioc' } },
    );
  }

  /**
   * Place a spot limit order.
   * @param coin - Base token symbol (e.g. "PURR", "HYPE")
   * @param isBuy - True to buy, false to sell
   * @param size - Size in base token units
   * @param price - Limit price in quote token (usually USDC)
   * @param tif - Time-in-force (default: Gtc)
   */
  async spotLimitOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    tif: 'Gtc' | 'Ioc' | 'Alo' = 'Gtc',
  ): Promise<OrderResponse> {
    return this.spotOrder(
      coin,
      isBuy,
      size,
      price,
      { limit: { tif } },
    );
  }

  /**
   * Cancel a spot order by coin and order ID.
   */
  async spotCancel(coin: string, oid: number): Promise<CancelResponse> {
    await this.requireTrading();
    await this.loadSpotMeta();

    const assetIndex = this.spotAssetMap.get(coin);
    if (assetIndex === undefined) {
      throw new Error(`Unknown spot asset: ${coin}`);
    }

    this.log(`Cancelling spot order: ${coin} (asset ${assetIndex}) oid ${oid}`);

    try {
      const response = await this.exchange.cancel({
        cancels: [{ a: assetIndex, o: oid }],
      }, this.vaultParam);
      this.log('Spot cancel response:', JSON.stringify(response, null, 2));
      return response as unknown as CancelResponse;
    } catch (error) {
      this.log('Spot cancel error:', error);
      return {
        status: 'err',
        response: { type: 'cancel', data: { statuses: [error instanceof Error ? error.message : String(error)] } },
      };
    }
  }

  // ============ Leverage ============

  async updateLeverage(
    coin: string,
    leverage: number,
    isCross: boolean = true
  ): Promise<unknown> {
    await this.requireTrading();
    await this.getMetaAndAssetCtxs();

    // HIP-3 perps only support isolated margin — override isCross and clamp leverage
    if (this.isHip3(coin)) {
      if (isCross) {
        this.log(`HIP-3 asset ${coin} does not support cross margin — forcing isolated`);
      }
      isCross = false;
      const maxLev = this.hip3MaxLeverageMap.get(coin) ?? 10;
      if (leverage > maxLev) {
        this.log(`HIP-3 asset ${coin} max leverage is ${maxLev}x — clamping from ${leverage}x`);
        leverage = maxLev;
      }
    }

    const assetIndex = this.getAssetIndex(coin);

    this.log(`Updating leverage: ${coin} (asset ${assetIndex}) to ${leverage}x ${isCross ? 'cross' : 'isolated'}`);

    try {
      const response = await this.exchange.updateLeverage({
        asset: assetIndex,
        isCross,
        leverage,
      }, this.vaultParam);
      this.log('Leverage response:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      this.log('Leverage error:', error);
      throw error;
    }
  }

  /**
   * Place a native Hyperliquid TWAP order.
   * The exchange handles slicing and timing server-side.
   * @param coin Asset symbol (e.g. "ETH")
   * @param isBuy true for long, false for short
   * @param size Total size in base currency
   * @param durationMinutes Duration in minutes (5–1440)
   * @param randomize Enable random order timing
   * @param reduceOnly Reduce-only flag
   * @param leverage Optional leverage to set before placing the TWAP
   */
  async twapOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    durationMinutes: number,
    randomize: boolean = true,
    reduceOnly: boolean = false,
    leverage?: number
  ) {
    await this.getMetaAndAssetCtxs();

    if (leverage) {
      await this.setLeverage(coin, leverage);
    }

    const assetIndex = this.getAssetIndex(coin);
    const roundedSize = roundSize(size, this.getSzDecimals(coin));

    this.log(`TWAP order: ${coin} (asset ${assetIndex}) ${isBuy ? 'BUY' : 'SELL'} ${roundedSize} over ${durationMinutes}m, randomize=${randomize}, reduceOnly=${reduceOnly}`);

    try {
      const response = await this.exchange.twapOrder({
        twap: {
          a: assetIndex,
          b: isBuy,
          s: String(roundedSize),
          r: reduceOnly,
          m: durationMinutes,
          t: randomize,
        },

      }, this.vaultParam);
      this.log('TWAP order response:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      this.log('TWAP order error:', error);
      throw error;
    }
  }

  /**
   * Cancel a running TWAP order.
   * @param coin Asset symbol (e.g. "ETH")
   * @param twapId The TWAP order ID to cancel
   */
  async twapCancel(coin: string, twapId: number) {
    await this.getMetaAndAssetCtxs();

    const assetIndex = this.getAssetIndex(coin);

    this.log(`TWAP cancel: ${coin} (asset ${assetIndex}) twapId=${twapId}`);

    try {
      const response = await this.exchange.twapCancel({
        a: assetIndex,
        t: twapId,
      }, this.vaultParam);
      this.log('TWAP cancel response:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      this.log('TWAP cancel error:', error);
      throw error;
    }
  }

  /**
   * Get TWAP order history for the current user.
   */
  async twapHistory() {
    const response = await this.info.twapHistory({ user: this.address as `0x${string}` });
    this.log('TWAP history:', JSON.stringify(response, null, 2));
    return response;
  }
}

// Singleton instance
let clientInstance: HyperliquidClient | null = null;

export function getClient(config?: OpenBrokerConfig): HyperliquidClient {
  if (!clientInstance) {
    clientInstance = new HyperliquidClient(config);
  }
  return clientInstance;
}

// Reset client (useful for testing)
export function resetClient(): void {
  clientInstance = null;
}
