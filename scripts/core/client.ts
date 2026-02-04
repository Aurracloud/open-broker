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
  public verbose: boolean = false;

  constructor(config?: OpenBrokerConfig) {
    this.config = config ?? loadConfig();
    this.account = privateKeyToAccount(this.config.privateKey);
    this.verbose = process.env.VERBOSE === '1' || process.env.VERBOSE === 'true';

    // Initialize SDK clients
    this.transport = new HttpTransport({ url: this.config.baseUrl });
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

  get address(): string {
    return this.config.accountAddress ?? this.account.address;
  }

  get walletAddress(): string {
    return this.account.address;
  }

  get builderInfo(): BuilderInfo {
    return {
      b: this.config.builderAddress.toLowerCase(),
      f: this.config.builderFee,
    };
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

    // Build lookup maps
    this.meta.meta.universe.forEach((asset, index) => {
      this.assetMap.set(asset.name, index);
      this.szDecimalsMap.set(asset.name, asset.szDecimals);
    });

    return this.meta;
  }

  async getAllMids(): Promise<Record<string, string>> {
    this.log('Fetching allMids...');
    const response = await this.info.allMids();
    return response;
  }

  getAssetIndex(coin: string): number {
    const index = this.assetMap.get(coin);
    if (index === undefined) {
      throw new Error(`Unknown asset: ${coin}. Available: ${Array.from(this.assetMap.keys()).slice(0, 10).join(', ')}...`);
    }
    return index;
  }

  getSzDecimals(coin: string): number {
    const decimals = this.szDecimalsMap.get(coin);
    if (decimals === undefined) {
      throw new Error(`Unknown asset: ${coin}`);
    }
    return decimals;
  }

  // ============ Account Info ============

  async getUserState(user?: string): Promise<ClearinghouseState> {
    this.log('Fetching clearinghouseState for:', user ?? this.address);
    const response = await this.info.clearinghouseState({ user: user ?? this.address });
    return response as ClearinghouseState;
  }

  async getOpenOrders(user?: string): Promise<OpenOrder[]> {
    this.log('Fetching openOrders for:', user ?? this.address);
    const response = await this.info.openOrders({ user: user ?? this.address });
    return response as OpenOrder[];
  }

  // ============ Trading ============

  async order(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    orderType: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } },
    reduceOnly: boolean = false,
    includeBuilder: boolean = true
  ): Promise<OrderResponse> {
    await this.getMetaAndAssetCtxs();

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

  async cancel(coin: string, oid: number): Promise<CancelResponse> {
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
