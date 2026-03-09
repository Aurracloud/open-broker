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
  /** HIP-3 assets that have had isolated margin set this session */
  private hip3IsolatedSet: Set<string> = new Set();
  /** Cached maxLeverage for HIP-3 assets */
  private hip3MaxLeverageMap: Map<string, number> = new Map();
  public verbose: boolean = false;

  constructor(config?: OpenBrokerConfig) {
    this.config = config ?? loadConfig();
    this.account = privateKeyToAccount(this.config.privateKey);
    this.verbose = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

    // Initialize SDK clients
    this.transport = new HttpTransport({ isMainnet: isMainnet() });
    this.info = new InfoClient({ transport: this.transport });
    this.exchange = new ExchangeClient({
      transport: this.transport,
      wallet: this.account,
      isMainnet: isMainnet(),
    });
  }

  private log(...args: unknown[]) {
    if (this.verbose) {
      console.log('[DEBUG]', ...args);
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

  /** Throw error if trying to trade in read-only mode */
  private requireTrading(): void {
    if (this.config.isReadOnly) {
      throw new Error(
        'Trading not available. Run "openbroker setup" to configure your wallet.'
      );
    }
  }

  // ============ Market Data ============

  async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    if (this.meta) return this.meta;

    this.log('Fetching metaAndAssetCtxs...');
    const response = await this.info.metaAndAssetCtxs();
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
  private async loadHip3Assets(): Promise<void> {
    try {
      const dexs = await this.getPerpDexs();
      const baseUrl = isMainnet()
        ? 'https://api.hyperliquid.xyz'
        : 'https://api.hyperliquid-testnet.xyz';

      for (let dexIdx = 1; dexIdx < dexs.length; dexIdx++) {
        const dex = dexs[dexIdx];
        if (!dex) continue;

        try {
          const dexResponse = await fetch(baseUrl + '/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dex.name }),
          });
          const dexData = await dexResponse.json();

          if (dexData && dexData[0]?.universe) {
            const universe = dexData[0].universe as Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }>;
            this.log(`Loading HIP-3 dex: ${dex.name} with ${universe.length} markets`);

            universe.forEach((asset, assetIdx) => {
              // API returns names already prefixed (e.g., "xyz:CL"), use as-is
              const coinName = asset.name;
              // Extract local name by stripping dex prefix if present
              const localName = coinName.startsWith(dex.name + ':') ? coinName.slice(dex.name.length + 1) : coinName;
              const globalIndex = 100000 + dexIdx * 10000 + assetIdx;

              this.assetMap.set(coinName, globalIndex);
              this.szDecimalsMap.set(coinName, asset.szDecimals);
              this.coinDexMap.set(coinName, { dexName: dex.name, dexIdx, localName });
              if (asset.maxLeverage) this.hip3MaxLeverageMap.set(coinName, asset.maxLeverage);
            });
          }
        } catch (e) {
          this.log(`Failed to load HIP-3 dex ${dex.name}:`, e);
        }
      }
    } catch (e) {
      this.log('Failed to load HIP-3 assets:', e);
    }
  }

  async getAllMids(): Promise<Record<string, string>> {
    this.log('Fetching allMids...');
    const response = await this.info.allMids() as Record<string, string>;

    // Also fetch HIP-3 dex mids
    try {
      const dexs = await this.getPerpDexs();
      const baseUrl = isMainnet()
        ? 'https://api.hyperliquid.xyz'
        : 'https://api.hyperliquid-testnet.xyz';

      for (let i = 1; i < dexs.length; i++) {
        const dex = dexs[i];
        if (!dex) continue;

        try {
          const dexResponse = await fetch(baseUrl + '/info', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'allMids', dex: dex.name }),
          });
          const dexMids = await dexResponse.json() as Record<string, string>;

          // Merge directly — API already returns prefixed keys (e.g., "xyz:CL")
          for (const [coin, mid] of Object.entries(dexMids)) {
            response[coin] = mid;
          }
        } catch (e) {
          this.log(`Failed to fetch mids for HIP-3 dex ${dex.name}:`, e);
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
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'perpDexs' }),
    });
    const data = await response.json();
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
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

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
    const mainResponse = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
    });
    const mainData = await mainResponse.json();
    this.log('Main dex data fetched');

    results.push({
      dexName: null,
      meta: { universe: mainData[0].universe },
      assetCtxs: mainData[1],
    });

    // Get HIP-3 dex names
    const dexs = await this.getPerpDexs();

    // Fetch each HIP-3 dex by name
    for (let i = 1; i < dexs.length; i++) {
      const dex = dexs[i];
      if (!dex) continue;

      try {
        const dexResponse = await fetch(baseUrl + '/info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: dex.name }),
        });
        const dexData = await dexResponse.json();

        if (dexData && dexData[0]?.universe) {
          this.log(`Fetched HIP-3 dex: ${dex.name} with ${dexData[0].universe.length} markets`);
          results.push({
            dexName: dex.name,
            meta: { universe: dexData[0].universe },
            assetCtxs: dexData[1] || [],
          });
        }
      } catch (e) {
        this.log(`Failed to fetch HIP-3 dex ${dex.name}:`, e);
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
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMeta' }),
    });
    const data = await response.json();
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
      dayNtlVlm: string;
      markPx: string;
      midPx: string;
      prevDayPx: string;
    }>;
  }> {
    this.log('Fetching spotMetaAndAssetCtxs...');
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'spotMetaAndAssetCtxs' }),
    });
    const data = await response.json();
    this.log('spotMetaAndAssetCtxs response:', JSON.stringify(data).slice(0, 500));
    return {
      meta: data[0],
      assetCtxs: data[1],
    };
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
    const baseUrl = isMainnet()
      ? 'https://api.hyperliquid.xyz'
      : 'https://api.hyperliquid-testnet.xyz';

    const response = await fetch(baseUrl + '/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'spotClearinghouseState',
        user: user ?? this.address,
      }),
    });
    const data = await response.json();
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
    const response = await this.info.l2Book({ coin });

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
      });
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
    const response = await this.info.clearinghouseState(params as any);
    return response as ClearinghouseState;
  }

  /**
   * Get user state across all dexes (main + HIP-3).
   * Returns the main state with HIP-3 positions merged into assetPositions.
   */
  async getUserStateAll(user?: string): Promise<ClearinghouseState> {
    await this.getMetaAndAssetCtxs(); // Ensure HIP-3 dex list is loaded

    const mainState = await this.getUserState(user);
    const dexs = await this.getPerpDexs();

    for (let i = 1; i < dexs.length; i++) {
      const dex = dexs[i];
      if (!dex) continue;

      try {
        const dexState = await this.getUserState(user, dex.name);
        if (dexState.assetPositions?.length > 0) {
          mainState.assetPositions.push(...dexState.assetPositions);
        }
      } catch (err) {
        this.log(`Failed to fetch state for dex ${dex.name}:`, err instanceof Error ? err.message : String(err));
      }
    }

    return mainState;
  }

  async getOpenOrders(user?: string): Promise<OpenOrder[]> {
    this.log('Fetching openOrders for:', user ?? this.address);
    const response = await this.info.openOrders({ user: user ?? this.address });
    return response as OpenOrder[];
  }

  // ============ Trading ============

  /**
   * HIP-3 perps have independent margin per dex. Before ordering:
   * 1. Set isolated margin mode (required for HIP-3)
   * 2. Transfer USDC from main perp to the HIP-3 dex (each dex has its own balance)
   */
  private async ensureHip3Ready(coin: string, notional: number): Promise<void> {
    if (!this.isHip3(coin)) return;

    const dexInfo = this.coinDexMap.get(coin);
    if (!dexInfo?.dexName) return;

    // Set isolated margin on first order per asset
    if (!this.hip3IsolatedSet.has(coin)) {
      const maxLev = this.hip3MaxLeverageMap.get(coin) ?? 10;
      this.log(`HIP-3 asset ${coin} (dex: ${dexInfo.dexName}) — setting isolated margin at ${maxLev}x`);
      try {
        await this.updateLeverage(coin, maxLev, false); // false = isolated
        this.hip3IsolatedSet.add(coin);
      } catch (err) {
        this.log(`Failed to set isolated margin for ${coin}:`, err instanceof Error ? err.message : String(err));
        this.hip3IsolatedSet.add(coin);
      }
    }

    // Transfer USDC to the HIP-3 dex to cover margin
    const maxLev = this.hip3MaxLeverageMap.get(coin) ?? 10;
    const requiredMargin = notional / maxLev;
    // Add 20% buffer for fees and slippage
    const transferAmount = Math.ceil(requiredMargin * 1.2 * 100) / 100;

    this.log(`HIP-3 margin transfer: ${transferAmount} USDC from main → ${dexInfo.dexName} (notional: ${notional}, leverage: ${maxLev}x)`);
    try {
      await this.exchange.sendAsset({
        destination: this.address as `0x${string}`,
        sourceDex: '',            // main perp dex
        destinationDex: dexInfo.dexName,
        token: 'USDC:0x6d1e7cde53ba9467b783cb7c530ce054',
        amount: String(transferAmount),
      });
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
    includeBuilder: boolean = true
  ): Promise<OrderResponse> {
    this.requireTrading();
    await this.getMetaAndAssetCtxs();

    // HIP-3 perps: set isolated margin + transfer USDC to dex
    await this.ensureHip3Ready(coin, size * price);

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

    // Add builder fee if configured
    if (includeBuilder && this.config.builderAddress !== '0x0000000000000000000000000000000000000000') {
      orderRequest.builder = this.builderInfo;
      this.log('Including builder fee:', this.builderInfo);
    }

    try {
      const response = await this.exchange.order(orderRequest);
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
    slippageBps?: number
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
      true
    );
  }

  async limitOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    tif: 'Gtc' | 'Ioc' | 'Alo' = 'Gtc',
    reduceOnly: boolean = false
  ): Promise<OrderResponse> {
    return this.order(
      coin,
      isBuy,
      size,
      price,
      { limit: { tif } },
      reduceOnly,
      true
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
    reduceOnly: boolean = true
  ): Promise<OrderResponse> {
    this.requireTrading();
    await this.getMetaAndAssetCtxs();

    // HIP-3 perps: set isolated margin + transfer USDC to dex
    await this.ensureHip3Ready(coin, size * limitPrice);

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

    // Add builder fee if configured
    if (this.config.builderAddress !== '0x0000000000000000000000000000000000000000') {
      orderRequest.builder = this.builderInfo;
      this.log('Including builder fee:', this.builderInfo);
    }

    try {
      const response = await this.exchange.order(orderRequest);
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
    this.requireTrading();
    await this.getMetaAndAssetCtxs();

    const assetIndex = this.getAssetIndex(coin);

    this.log(`Cancelling order: ${coin} (asset ${assetIndex}) oid ${oid}`);

    try {
      const response = await this.exchange.cancel({
        cancels: [{ a: assetIndex, o: oid }],
      });
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

  // ============ Leverage ============

  async updateLeverage(
    coin: string,
    leverage: number,
    isCross: boolean = true
  ): Promise<unknown> {
    this.requireTrading();
    await this.getMetaAndAssetCtxs();

    const assetIndex = this.getAssetIndex(coin);

    this.log(`Updating leverage: ${coin} (asset ${assetIndex}) to ${leverage}x ${isCross ? 'cross' : 'isolated'}`);

    try {
      const response = await this.exchange.updateLeverage({
        asset: assetIndex,
        isCross,
        leverage,
      });
      this.log('Leverage response:', JSON.stringify(response, null, 2));
      return response;
    } catch (error) {
      this.log('Leverage error:', error);
      throw error;
    }
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
