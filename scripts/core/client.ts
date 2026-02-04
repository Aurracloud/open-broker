// Hyperliquid Client for Open Broker
// Handles signing, API communication, and builder fee injection

import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import type {
  OpenBrokerConfig,
  BuilderInfo,
  OrderRequest,
  OrderWire,
  OrderResponse,
  CancelRequest,
  CancelResponse,
  MetaAndAssetCtxs,
  ClearinghouseState,
  OpenOrder,
  InfoRequest,
} from './types.js';
import { loadConfig, isMainnet } from './config.js';
import { orderToWire, getTimestampMs } from './utils.js';

// EIP-712 Domain for Hyperliquid
const MAINNET_CHAIN_ID = 1337; // Hyperliquid L1
const TESTNET_CHAIN_ID = 421614; // Arbitrum Sepolia

interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
}

function getL1Domain(isMainnetEnv: boolean): EIP712Domain {
  return {
    name: 'Exchange',
    version: '1',
    chainId: isMainnetEnv ? MAINNET_CHAIN_ID : TESTNET_CHAIN_ID,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  };
}

// Action type hash for order actions
const ACTION_TYPE_HASH = keccak256(
  new TextEncoder().encode(
    'HyperliquidTransaction:Agent(address source,uint64 connectionId,bool isMainnet)'
  )
);

export class HyperliquidClient {
  private config: OpenBrokerConfig;
  private account: PrivateKeyAccount;
  private meta: MetaAndAssetCtxs | null = null;
  private assetMap: Map<string, number> = new Map();
  private szDecimalsMap: Map<string, number> = new Map();

  constructor(config?: OpenBrokerConfig) {
    this.config = config ?? loadConfig();
    this.account = privateKeyToAccount(this.config.privateKey);
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

  // ============ API Methods ============

  private async post(endpoint: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async info(request: InfoRequest): Promise<unknown> {
    return this.post('/info', request);
  }

  // ============ Signing ============

  private async signL1Action(
    action: Record<string, unknown>,
    nonce: number,
    vaultAddress?: string | null
  ): Promise<{ r: string; s: string; v: number }> {
    const isMainnetEnv = isMainnet();

    // Construct the phantom agent for signing
    const connectionId = BigInt(nonce);

    // Create the agent struct hash
    const agentHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters('bytes32, address, uint64, bool'),
        [
          ACTION_TYPE_HASH,
          (vaultAddress ?? this.account.address) as `0x${string}`,
          connectionId,
          isMainnetEnv,
        ]
      )
    );

    // Create the typed data for signing
    const domain = getL1Domain(isMainnetEnv);
    const types = {
      Agent: [
        { name: 'source', type: 'address' },
        { name: 'connectionId', type: 'uint64' },
        { name: 'isMainnet', type: 'bool' },
      ],
    };

    const message = {
      source: vaultAddress ?? this.account.address,
      connectionId: BigInt(nonce),
      isMainnet: isMainnetEnv,
    };

    // Sign the typed data
    const signature = await this.account.signTypedData({
      domain,
      types,
      primaryType: 'Agent',
      message,
    });

    // Parse signature into r, s, v
    const r = signature.slice(0, 66);
    const s = '0x' + signature.slice(66, 130);
    const v = parseInt(signature.slice(130, 132), 16);

    return {
      r,
      s,
      v,
    };
  }

  private async exchange(
    action: Record<string, unknown>,
    vaultAddress?: string | null
  ): Promise<unknown> {
    const nonce = getTimestampMs();
    const signature = await this.signL1Action(action, nonce, vaultAddress);

    const payload = {
      action,
      nonce,
      signature,
      vaultAddress: vaultAddress ?? null,
    };

    return this.post('/exchange', payload);
  }

  // ============ Market Data ============

  async getMetaAndAssetCtxs(): Promise<MetaAndAssetCtxs> {
    if (this.meta) return this.meta;

    const response = await this.info({ type: 'metaAndAssetCtxs' }) as [
      { universe: Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated: boolean }> },
      Array<{ funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium: string; oraclePx: string; markPx: string }>
    ];

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
    const response = await this.info({ type: 'allMids' }) as Record<string, string>;
    return response;
  }

  getAssetIndex(coin: string): number {
    const index = this.assetMap.get(coin);
    if (index === undefined) {
      throw new Error(`Unknown asset: ${coin}`);
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
    const response = await this.info({
      type: 'clearinghouseState',
      user: user ?? this.address,
    });
    return response as ClearinghouseState;
  }

  async getOpenOrders(user?: string): Promise<OpenOrder[]> {
    const response = await this.info({
      type: 'openOrders',
      user: user ?? this.address,
    });
    return response as OpenOrder[];
  }

  // ============ Trading ============

  async order(
    request: OrderRequest,
    includeBuilder: boolean = true
  ): Promise<OrderResponse> {
    // Ensure we have metadata loaded
    await this.getMetaAndAssetCtxs();

    const assetIndex = this.getAssetIndex(request.coin);
    const szDecimals = this.getSzDecimals(request.coin);
    const orderWire = orderToWire(request, assetIndex, szDecimals);

    const action: Record<string, unknown> = {
      type: 'order',
      orders: [orderWire],
      grouping: 'na',
    };

    if (includeBuilder && this.config.builderAddress !== '0x0000000000000000000000000000000000000000') {
      action.builder = this.builderInfo;
    }

    const response = await this.exchange(action);
    return response as OrderResponse;
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
      throw new Error(`No mid price for ${coin}`);
    }

    // Calculate slippage price
    const slippage = (slippageBps ?? this.config.slippageBps) / 10000;
    const limitPrice = isBuy
      ? midPrice * (1 + slippage)
      : midPrice * (1 - slippage);

    return this.order({
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: limitPrice,
      order_type: { limit: { tif: 'Ioc' } },
      reduce_only: false,
    });
  }

  async limitOrder(
    coin: string,
    isBuy: boolean,
    size: number,
    price: number,
    tif: 'Gtc' | 'Ioc' | 'Alo' = 'Gtc',
    reduceOnly: boolean = false
  ): Promise<OrderResponse> {
    return this.order({
      coin,
      is_buy: isBuy,
      sz: size,
      limit_px: price,
      order_type: { limit: { tif } },
      reduce_only: reduceOnly,
    });
  }

  async cancel(coin: string, oid: number): Promise<CancelResponse> {
    await this.getMetaAndAssetCtxs();

    const assetIndex = this.getAssetIndex(coin);

    const action = {
      type: 'cancel',
      cancels: [{ a: assetIndex, o: oid }],
    };

    const response = await this.exchange(action);
    return response as CancelResponse;
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

    const action = {
      type: 'updateLeverage',
      asset: assetIndex,
      isCross,
      leverage,
    };

    return this.exchange(action);
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
