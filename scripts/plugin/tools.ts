// Agent Tools for the OpenBroker OpenClaw plugin
// Uses direct imports of core modules instead of shelling out to CLI

import type { PluginTool } from './types.js';
import type { PositionWatcher } from './watcher.js';

/** Helper to wrap a result as OpenClaw tool response */
function json(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

/** Helper to wrap an error */
function error(message: string) {
  return json({ error: message });
}

export function createTools(watcher: PositionWatcher | null): PluginTool[] {
  return [
    // ── Info Tools ──────────────────────────────────────────────

    {
      name: 'ob_account',
      description: 'View Hyperliquid account balance, equity, margin, and optionally open orders',
      parameters: {
        type: 'object',
        properties: {
          orders: { type: 'boolean', description: 'Include open orders in output' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const state = await client.getUserState();

        const result: Record<string, unknown> = {
          address: client.address,
          isApiWallet: client.isApiWallet,
          equity: state.marginSummary.accountValue,
          totalNtlPos: state.marginSummary.totalNtlPos,
          totalMarginUsed: state.marginSummary.totalMarginUsed,
          withdrawable: state.marginSummary.withdrawable,
          positions: state.assetPositions
            .filter(ap => parseFloat(ap.position.szi) !== 0)
            .map(ap => ({
              coin: ap.position.coin,
              size: ap.position.szi,
              entryPrice: ap.position.entryPx,
              positionValue: ap.position.positionValue,
              unrealizedPnl: ap.position.unrealizedPnl,
              liquidationPx: ap.position.liquidationPx,
              leverage: ap.position.leverage,
            })),
        };

        if (params.orders) {
          const orders = await client.getOpenOrders();
          result.openOrders = orders.map(o => ({
            coin: o.coin,
            oid: o.oid,
            side: o.side,
            size: o.sz,
            price: o.limitPx,
            orderType: o.orderType,
            timestamp: o.timestamp,
          }));
        }

        return json(result);
      },
    },

    {
      name: 'ob_positions',
      description: 'View open positions with entry price, mark price, PnL, liquidation price, and leverage',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Filter by coin symbol (e.g. ETH, BTC)' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const state = await client.getUserState();

        let positions = state.assetPositions
          .filter(ap => parseFloat(ap.position.szi) !== 0)
          .map(ap => ({
            coin: ap.position.coin,
            side: parseFloat(ap.position.szi) > 0 ? 'long' : 'short',
            size: ap.position.szi,
            entryPrice: ap.position.entryPx,
            positionValue: ap.position.positionValue,
            unrealizedPnl: ap.position.unrealizedPnl,
            returnOnEquity: ap.position.returnOnEquity,
            liquidationPx: ap.position.liquidationPx,
            leverage: ap.position.leverage,
            marginUsed: ap.position.marginUsed,
          }));

        if (params.coin) {
          const coin = (params.coin as string).toUpperCase();
          positions = positions.filter(p => p.coin === coin);
        }

        return json({ address: client.address, positions });
      },
    },

    {
      name: 'ob_funding',
      description: 'View funding rates for Hyperliquid perpetuals, sorted by annualized rate',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Filter by coin symbol' },
          top: { type: 'number', description: 'Show top N results (default: 20)' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { annualizeFundingRate } = await import('../core/utils.js');
        const client = getClient();
        const raw = await client.getPredictedFundings();

        // raw is Array<[coin, Array<[venue, { fundingRate, nextFundingTime }]>]>
        let results = raw.map(([coin, venues]) => {
          // Use the first venue's funding rate
          const rate = venues.length > 0 ? parseFloat(venues[0][1].fundingRate) : 0;
          return {
            coin,
            fundingRate: rate,
            annualizedRate: annualizeFundingRate(rate),
            venues: venues.map(([venue, data]) => ({ venue, fundingRate: data.fundingRate })),
          };
        });

        if (params.coin) {
          const coin = (params.coin as string).toUpperCase();
          results = results.filter(r => r.coin === coin);
        }

        results.sort((a, b) => Math.abs(b.annualizedRate) - Math.abs(a.annualizedRate));

        const top = (params.top as number) || 20;
        results = results.slice(0, top);

        return json({ fundings: results });
      },
    },

    {
      name: 'ob_markets',
      description: 'View market data for Hyperliquid perpetuals (price, volume, open interest)',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Filter by coin symbol' },
          top: { type: 'number', description: 'Show top N results (default: 30)' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const { meta, assetCtxs } = await client.getMetaAndAssetCtxs();

        let markets = meta.universe.map((asset, i) => ({
          coin: asset.name,
          szDecimals: asset.szDecimals,
          maxLeverage: asset.maxLeverage,
          markPx: assetCtxs[i]?.markPx,
          midPx: assetCtxs[i]?.midPx,
          oraclePx: assetCtxs[i]?.oraclePx,
          funding: assetCtxs[i]?.funding,
          openInterest: assetCtxs[i]?.openInterest,
          dayVolume: assetCtxs[i]?.dayNtlVlm,
          prevDayPx: assetCtxs[i]?.prevDayPx,
        }));

        if (params.coin) {
          const coin = (params.coin as string).toUpperCase();
          markets = markets.filter(m => m.coin === coin);
        }

        const top = (params.top as number) || 30;
        markets = markets.slice(0, top);

        return json({ markets });
      },
    },

    {
      name: 'ob_search',
      description: 'Search for assets across all Hyperliquid market providers (perps, HIP-3, spot)',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (e.g. GOLD, BTC, ETH)' },
          type: { type: 'string', description: 'Filter by market type: perp, hip3, spot' },
        },
        required: ['query'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const query = (params.query as string).toUpperCase();
        const typeFilter = params.type as string | undefined;

        const results: Array<Record<string, unknown>> = [];

        // Search main perps
        if (!typeFilter || typeFilter === 'perp') {
          const { meta, assetCtxs } = await client.getMetaAndAssetCtxs();
          for (let i = 0; i < meta.universe.length; i++) {
            const asset = meta.universe[i];
            if (asset.name.toUpperCase().includes(query)) {
              results.push({
                coin: asset.name,
                type: 'perp',
                markPx: assetCtxs[i]?.markPx,
                dayVolume: assetCtxs[i]?.dayNtlVlm,
                maxLeverage: asset.maxLeverage,
              });
            }
          }
        }

        // Search spot
        if (!typeFilter || typeFilter === 'spot') {
          try {
            const spotData = await client.getSpotMetaAndAssetCtxs();
            for (let i = 0; i < spotData.meta.universe.length; i++) {
              const pair = spotData.meta.universe[i];
              if (pair.name.toUpperCase().includes(query)) {
                results.push({
                  coin: pair.name,
                  type: 'spot',
                  markPx: spotData.assetCtxs[i]?.markPx,
                  dayVolume: spotData.assetCtxs[i]?.dayNtlVlm,
                });
              }
            }
          } catch { /* spot may not be available */ }
        }

        return json({ query, results });
      },
    },

    {
      name: 'ob_spot',
      description: 'View spot markets, balances, and token info on Hyperliquid',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Filter by coin symbol' },
          balances: { type: 'boolean', description: 'Show your spot token balances' },
          top: { type: 'number', description: 'Show top N results' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();

        if (params.balances) {
          const balances = await client.getSpotBalances();
          return json({ address: client.address, balances });
        }

        const spotData = await client.getSpotMetaAndAssetCtxs();
        return json({ spotData });
      },
    },

    {
      name: 'ob_fills',
      description: 'View trade fill history with prices, fees, and realized PnL',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Filter by coin symbol (e.g. ETH, BTC)' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Filter by side' },
          top: { type: 'number', description: 'Number of recent fills to return (default: 20)' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        let fills = await client.getUserFills();

        if (params.coin) {
          const coin = (params.coin as string).toUpperCase();
          fills = fills.filter(f => f.coin === coin);
        }
        if (params.side) {
          const sideCode = (params.side as string) === 'buy' ? 'B' : 'A';
          fills = fills.filter(f => f.side === sideCode);
        }

        fills.sort((a, b) => b.time - a.time);
        const top = (params.top as number) || 20;
        fills = fills.slice(0, top);

        const totalFees = fills.reduce((s, f) => s + parseFloat(f.fee), 0);
        const totalPnl = fills.reduce((s, f) => s + parseFloat(f.closedPnl), 0);

        return json({
          address: client.address,
          fills: fills.map(f => ({
            coin: f.coin,
            side: f.side === 'B' ? 'buy' : 'sell',
            size: f.sz,
            price: f.px,
            fee: f.fee,
            closedPnl: f.closedPnl,
            time: f.time,
            oid: f.oid,
            crossed: f.crossed,
          })),
          totalFees: String(totalFees),
          totalClosedPnl: String(totalPnl),
        });
      },
    },

    {
      name: 'ob_orders',
      description: 'View order history with status (filled, canceled, open, etc.)',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Filter by coin symbol' },
          status: { type: 'string', description: 'Filter by status (filled, canceled, open, etc.)' },
          top: { type: 'number', description: 'Number of recent orders (default: 20)' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        let orders = await client.getHistoricalOrders();

        if (params.coin) {
          const coin = (params.coin as string).toUpperCase();
          orders = orders.filter(o => o.order.coin === coin);
        }
        if (params.status) {
          const s = (params.status as string).toLowerCase();
          orders = orders.filter(o => o.status.toLowerCase().includes(s));
        }

        orders.sort((a, b) => b.order.timestamp - a.order.timestamp);
        const top = (params.top as number) || 20;
        orders = orders.slice(0, top);

        return json({
          address: client.address,
          orders: orders.map(e => ({
            coin: e.order.coin,
            side: e.order.side === 'B' ? 'buy' : 'sell',
            size: e.order.sz,
            origSize: e.order.origSz,
            price: e.order.limitPx,
            orderType: e.order.orderType,
            tif: e.order.tif,
            oid: e.order.oid,
            status: e.status,
            timestamp: e.order.timestamp,
            statusTimestamp: e.statusTimestamp,
            reduceOnly: e.order.reduceOnly,
            isTrigger: e.order.isTrigger,
            triggerPx: e.order.triggerPx,
          })),
        });
      },
    },

    {
      name: 'ob_order_status',
      description: 'Check the status of a specific order by order ID',
      parameters: {
        type: 'object',
        properties: {
          oid: { type: 'number', description: 'Order ID to check' },
        },
        required: ['oid'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const result = await client.getOrderStatus(params.oid as number);

        if (result.status === 'unknownOid') {
          return json({ found: false, oid: params.oid });
        }

        if (result.order) {
          const o = result.order.order;
          return json({
            found: true,
            coin: o.coin,
            side: o.side === 'B' ? 'buy' : 'sell',
            size: o.sz,
            origSize: o.origSz,
            price: o.limitPx,
            orderType: o.orderType,
            tif: o.tif,
            oid: o.oid,
            status: result.order.status,
            timestamp: o.timestamp,
            statusTimestamp: result.order.statusTimestamp,
            reduceOnly: o.reduceOnly,
            isTrigger: o.isTrigger,
            triggerPx: o.triggerPx,
          });
        }

        return json(result);
      },
    },

    {
      name: 'ob_fees',
      description: 'View fee schedule, tier, maker/taker rates, and recent daily trading volumes',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const fees = await client.getUserFees();

        return json({
          address: client.address,
          perpTakerRate: fees.userCrossRate,
          perpMakerRate: fees.userAddRate,
          spotTakerRate: fees.userSpotCrossRate,
          spotMakerRate: fees.userSpotAddRate,
          referralDiscount: fees.activeReferralDiscount,
          stakingDiscount: fees.activeStakingDiscount,
          recentVolume: fees.dailyUserVlm?.slice(-7),
        });
      },
    },

    {
      name: 'ob_candles',
      description: 'Get OHLCV candle data for an asset',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol (e.g. ETH, BTC)' },
          interval: { type: 'string', description: 'Candle interval: 1m, 5m, 15m, 1h, 4h, 1d, etc. (default: 1h)' },
          bars: { type: 'number', description: 'Number of bars to fetch (default: 24)' },
        },
        required: ['coin'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();

        const coin = (params.coin as string).toUpperCase();
        const interval = (params.interval as string) || '1h';
        const bars = (params.bars as number) || 24;

        const intervalMs: Record<string, number> = {
          '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
          '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
          '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
        };

        const now = Date.now();
        const startTime = now - (bars * (intervalMs[interval] || 3_600_000));
        const candles = await client.getCandleSnapshot(coin, interval, startTime);

        return json({
          coin,
          interval,
          candles: candles.map(c => ({
            time: c.t,
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
            volume: c.v,
            trades: c.n,
          })),
        });
      },
    },

    {
      name: 'ob_funding_history',
      description: 'Get historical funding rates for an asset over a time period',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol (e.g. ETH, BTC)' },
          hours: { type: 'number', description: 'Hours of history (default: 24)' },
        },
        required: ['coin'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { annualizeFundingRate } = await import('../core/utils.js');
        const client = getClient();

        const coin = (params.coin as string).toUpperCase();
        const hours = (params.hours as number) || 24;
        const startTime = Date.now() - (hours * 3_600_000);

        const history = await client.getFundingHistory(coin, startTime);

        const rates = history.map(e => parseFloat(e.fundingRate));
        const avgRate = rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;

        return json({
          coin,
          hours,
          samples: history.length,
          avgHourlyRate: String(avgRate),
          avgAnnualizedRate: String(annualizeFundingRate(avgRate)),
          history: history.map(e => ({
            time: e.time,
            fundingRate: e.fundingRate,
            premium: e.premium,
          })),
        });
      },
    },

    {
      name: 'ob_trades',
      description: 'Get recent trades (tape/time & sales) for an asset',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol (e.g. ETH, BTC)' },
          top: { type: 'number', description: 'Number of trades (default: 30)' },
        },
        required: ['coin'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();

        const coin = (params.coin as string).toUpperCase();
        let trades = await client.getRecentTrades(coin);

        trades.sort((a, b) => b.time - a.time);
        const top = (params.top as number) || 30;
        trades = trades.slice(0, top);

        let buyVol = 0;
        let sellVol = 0;
        for (const t of trades) {
          const ntl = parseFloat(t.px) * parseFloat(t.sz);
          if (t.side === 'B') buyVol += ntl;
          else sellVol += ntl;
        }

        return json({
          coin,
          trades: trades.map(t => ({
            side: t.side === 'B' ? 'buy' : 'sell',
            size: t.sz,
            price: t.px,
            time: t.time,
          })),
          totalVolume: String(buyVol + sellVol),
          buyVolume: String(buyVol),
          sellVolume: String(sellVol),
        });
      },
    },

    {
      name: 'ob_rate_limit',
      description: 'Check API rate limit usage, capacity, and cumulative trading volume',
      parameters: {
        type: 'object',
        properties: {},
      },
      async execute() {
        const { getClient } = await import('../core/client.js');
        const client = getClient();
        const rl = await client.getUserRateLimit();

        return json({
          address: client.address,
          requestsUsed: rl.nRequestsUsed,
          requestsCap: rl.nRequestsCap,
          requestsSurplus: rl.nRequestsSurplus,
          usagePercent: rl.nRequestsCap > 0 ? (rl.nRequestsUsed / rl.nRequestsCap * 100).toFixed(1) + '%' : '0%',
          cumulativeVolume: rl.cumVlm,
        });
      },
    },

    // ── Trading Tools ───────────────────────────────────────────

    {
      name: 'ob_buy',
      description: 'Quick market buy on Hyperliquid. Always use dry=true first to preview.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol (ETH, BTC, SOL, etc.)' },
          size: { type: 'number', description: 'Order size in base asset' },
          slippage: { type: 'number', description: 'Slippage tolerance in bps (default: 50)' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'size'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { roundSize, getSlippagePrice } = await import('../core/utils.js');
        const client = getClient();

        if (client.isReadOnly) return error('Wallet not configured. Run "openbroker setup" first.');

        const coin = (params.coin as string).toUpperCase();
        const size = params.size as number;
        const slippageBps = (params.slippage as number) ?? client.builderInfo.f;

        const mids = await client.getAllMids();
        const midPrice = parseFloat(mids[coin]);
        if (!midPrice) return error(`Unknown coin: ${coin}`);

        const szDecimals = await client.getSzDecimals(coin);
        const roundedSize = roundSize(size, szDecimals);
        const slippagePrice = getSlippagePrice(midPrice, true, slippageBps);

        if (params.dry) {
          return json({
            dryRun: true,
            action: 'buy',
            coin,
            size: roundedSize,
            midPrice,
            slippagePrice,
            slippageBps,
          });
        }

        const result = await client.marketOrder(coin, true, parseFloat(roundedSize), slippageBps);
        return json({ action: 'buy', coin, size: roundedSize, result });
      },
    },

    {
      name: 'ob_sell',
      description: 'Quick market sell on Hyperliquid. Always use dry=true first to preview.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol (ETH, BTC, SOL, etc.)' },
          size: { type: 'number', description: 'Order size in base asset' },
          slippage: { type: 'number', description: 'Slippage tolerance in bps (default: 50)' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'size'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { roundSize, getSlippagePrice } = await import('../core/utils.js');
        const client = getClient();

        if (client.isReadOnly) return error('Wallet not configured. Run "openbroker setup" first.');

        const coin = (params.coin as string).toUpperCase();
        const size = params.size as number;
        const slippageBps = (params.slippage as number) ?? client.builderInfo.f;

        const mids = await client.getAllMids();
        const midPrice = parseFloat(mids[coin]);
        if (!midPrice) return error(`Unknown coin: ${coin}`);

        const szDecimals = await client.getSzDecimals(coin);
        const roundedSize = roundSize(size, szDecimals);
        const slippagePrice = getSlippagePrice(midPrice, false, slippageBps);

        if (params.dry) {
          return json({
            dryRun: true,
            action: 'sell',
            coin,
            size: roundedSize,
            midPrice,
            slippagePrice,
            slippageBps,
          });
        }

        const result = await client.marketOrder(coin, false, parseFloat(roundedSize), slippageBps);
        return json({ action: 'sell', coin, size: roundedSize, result });
      },
    },

    {
      name: 'ob_limit',
      description: 'Place a limit order on Hyperliquid. Always use dry=true first to preview.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Order direction' },
          size: { type: 'number', description: 'Order size in base asset' },
          price: { type: 'number', description: 'Limit price' },
          tif: { type: 'string', enum: ['GTC', 'IOC', 'ALO'], description: 'Time in force (default: GTC)' },
          reduce: { type: 'boolean', description: 'Reduce-only order' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'side', 'size', 'price'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { roundSize, roundPrice } = await import('../core/utils.js');
        const client = getClient();

        if (client.isReadOnly) return error('Wallet not configured. Run "openbroker setup" first.');

        const coin = (params.coin as string).toUpperCase();
        const isBuy = params.side === 'buy';
        const size = params.size as number;
        const price = params.price as number;
        const tif = ((params.tif as string) || 'GTC').toLowerCase();
        const reduceOnly = (params.reduce as boolean) || false;

        const szDecimals = await client.getSzDecimals(coin);
        const roundedSize = roundSize(size, szDecimals);
        const roundedPrice = roundPrice(price, szDecimals);

        // Map tif string to SDK format
        const tifMap: Record<string, 'Gtc' | 'Ioc' | 'Alo'> = { gtc: 'Gtc', ioc: 'Ioc', alo: 'Alo' };
        const sdkTif = tifMap[tif] || 'Gtc';

        if (params.dry) {
          return json({
            dryRun: true,
            action: 'limit',
            coin,
            side: params.side,
            size: roundedSize,
            price: roundedPrice,
            tif: sdkTif,
            reduceOnly,
          });
        }

        const result = await client.limitOrder(
          coin, isBuy, parseFloat(roundedSize), parseFloat(roundedPrice), sdkTif, reduceOnly,
        );
        return json({ action: 'limit', coin, side: params.side, size: roundedSize, price: roundedPrice, result });
      },
    },

    {
      name: 'ob_trigger',
      description: 'Place a trigger order (take profit or stop loss) on Hyperliquid. Always use dry=true first.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Order direction' },
          size: { type: 'number', description: 'Order size in base asset' },
          trigger: { type: 'number', description: 'Trigger price' },
          type: { type: 'string', enum: ['tp', 'sl'], description: 'Trigger type: tp (take profit) or sl (stop loss)' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'side', 'size', 'trigger', 'type'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { roundSize, roundPrice } = await import('../core/utils.js');
        const client = getClient();

        if (client.isReadOnly) return error('Wallet not configured. Run "openbroker setup" first.');

        const coin = (params.coin as string).toUpperCase();
        const isBuy = params.side === 'buy';
        const size = params.size as number;
        const triggerPrice = params.trigger as number;
        const tpsl = params.type as 'tp' | 'sl';

        const szDecimals = await client.getSzDecimals(coin);
        const roundedSize = roundSize(size, szDecimals);
        const roundedTrigger = roundPrice(triggerPrice, szDecimals);

        if (params.dry) {
          return json({
            dryRun: true,
            action: 'trigger',
            coin,
            side: params.side,
            size: roundedSize,
            triggerPrice: roundedTrigger,
            type: tpsl,
          });
        }

        let result;
        if (tpsl === 'sl') {
          result = await client.stopLoss(coin, isBuy, parseFloat(roundedSize), parseFloat(roundedTrigger));
        } else {
          result = await client.takeProfit(coin, isBuy, parseFloat(roundedSize), parseFloat(roundedTrigger));
        }
        return json({ action: 'trigger', coin, type: tpsl, size: roundedSize, triggerPrice: roundedTrigger, result });
      },
    },

    {
      name: 'ob_tpsl',
      description: 'Set take profit and/or stop loss on an existing position. Supports absolute price, percentage (+10%, -5%), and "entry" keyword.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol' },
          tp: { type: 'string', description: 'Take profit price (absolute, +10%, or "entry")' },
          sl: { type: 'string', description: 'Stop loss price (absolute, -5%, or "entry")' },
          size: { type: 'number', description: 'Position size (defaults to full position)' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin'],
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const { roundSize, roundPrice } = await import('../core/utils.js');
        const client = getClient();

        if (client.isReadOnly) return error('Wallet not configured. Run "openbroker setup" first.');
        if (!params.tp && !params.sl) return error('At least one of tp or sl is required.');

        const coin = (params.coin as string).toUpperCase();

        // Get current position
        const state = await client.getUserState();
        const position = state.assetPositions.find(
          ap => ap.position.coin === coin && parseFloat(ap.position.szi) !== 0,
        );
        if (!position) return error(`No open position for ${coin}`);

        const posSize = parseFloat(position.position.szi);
        const entryPx = parseFloat(position.position.entryPx);
        const isLong = posSize > 0;
        const szDecimals = await client.getSzDecimals(coin);
        const orderSize = params.size ? parseFloat(roundSize(params.size as number, szDecimals)) : Math.abs(posSize);

        // Parse price helper
        const parsePrice = (input: string): number => {
          if (input.toLowerCase() === 'entry') return entryPx;
          if (input.endsWith('%')) {
            const pct = parseFloat(input.replace('%', ''));
            return entryPx * (1 + pct / 100);
          }
          return parseFloat(input);
        };

        const results: Record<string, unknown> = { coin, positionSize: posSize, entryPrice: entryPx };

        if (params.tp) {
          const tpPrice = parsePrice(params.tp as string);
          const roundedTp = parseFloat(roundPrice(tpPrice, szDecimals));
          results.tpPrice = roundedTp;

          if (!params.dry) {
            // TP closes position: long → sell, short → buy
            results.tpResult = await client.takeProfit(coin, !isLong, orderSize, roundedTp);
          }
        }

        if (params.sl) {
          const slPrice = parsePrice(params.sl as string);
          const roundedSl = parseFloat(roundPrice(slPrice, szDecimals));
          results.slPrice = roundedSl;

          if (!params.dry) {
            results.slResult = await client.stopLoss(coin, !isLong, orderSize, roundedSl);
          }
        }

        if (params.dry) results.dryRun = true;

        return json(results);
      },
    },

    {
      name: 'ob_cancel',
      description: 'Cancel open orders on Hyperliquid',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Cancel orders for this coin only' },
          oid: { type: 'number', description: 'Cancel specific order by ID' },
          all: { type: 'boolean', description: 'Cancel all open orders' },
        },
      },
      async execute(_id, params) {
        const { getClient } = await import('../core/client.js');
        const client = getClient();

        if (client.isReadOnly) return error('Wallet not configured. Run "openbroker setup" first.');

        if (params.oid) {
          const coin = params.coin as string | undefined;
          if (!coin) return error('--coin is required when cancelling by order ID');
          const result = await client.cancel(coin.toUpperCase(), params.oid as number);
          return json({ action: 'cancel', coin: coin.toUpperCase(), oid: params.oid, result });
        }

        if (params.all || params.coin) {
          const coin = params.coin ? (params.coin as string).toUpperCase() : undefined;
          const results = await client.cancelAll(coin);
          return json({ action: 'cancelAll', coin: coin ?? 'all', results });
        }

        return error('Specify --all, --coin, or --oid to cancel orders.');
      },
    },

    // ── Advanced Execution (shell out — these are long-running scripts) ──

    {
      name: 'ob_twap',
      description: 'Execute a TWAP (time-weighted average price) order, splitting a large order into smaller slices over time. This is a long-running command.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Order direction' },
          size: { type: 'number', description: 'Total order size' },
          duration: { type: 'number', description: 'Duration in seconds' },
          intervals: { type: 'number', description: 'Number of slices' },
          randomize: { type: 'number', description: 'Randomize timing by this % (0-50)' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'side', 'size', 'duration'],
      },
      async execute(_id, params) {
        const { execFile } = await import('node:child_process');
        const args = ['twap'];
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === false || value === '') continue;
          if (value === true) args.push(`--${key}`);
          else args.push(`--${key}`, String(value));
        }

        return new Promise((resolve) => {
          execFile('openbroker', args, { timeout: 600_000 }, (_err, stdout, stderr) => {
            resolve({ content: [{ type: 'text' as const, text: (stdout + (stderr || '')).trim() }] });
          });
        });
      },
    },

    {
      name: 'ob_bracket',
      description: 'Place a bracket order: entry + take profit + stop loss in one command',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Order direction' },
          size: { type: 'number', description: 'Order size' },
          tp: { type: 'number', description: 'Take profit percentage from entry' },
          sl: { type: 'number', description: 'Stop loss percentage from entry' },
          entry: { type: 'string', enum: ['market', 'limit'], description: 'Entry type (default: market)' },
          price: { type: 'number', description: 'Entry price (required if entry=limit)' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'side', 'size', 'tp', 'sl'],
      },
      async execute(_id, params) {
        const { execFile } = await import('node:child_process');
        const args = ['bracket'];
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === false || value === '') continue;
          if (value === true) args.push(`--${key}`);
          else args.push(`--${key}`, String(value));
        }

        return new Promise((resolve) => {
          execFile('openbroker', args, { timeout: 60_000 }, (_err, stdout, stderr) => {
            resolve({ content: [{ type: 'text' as const, text: (stdout + (stderr || '')).trim() }] });
          });
        });
      },
    },

    {
      name: 'ob_chase',
      description: 'Chase price with ALO (post-only) orders, continuously replacing until filled. This is a long-running command.',
      parameters: {
        type: 'object',
        properties: {
          coin: { type: 'string', description: 'Asset symbol' },
          side: { type: 'string', enum: ['buy', 'sell'], description: 'Order direction' },
          size: { type: 'number', description: 'Order size' },
          offset: { type: 'number', description: 'Tick offset from best price (default: 1)' },
          timeout: { type: 'number', description: 'Timeout in seconds' },
          dry: { type: 'boolean', description: 'Preview without executing' },
        },
        required: ['coin', 'side', 'size'],
      },
      async execute(_id, params) {
        const { execFile } = await import('node:child_process');
        const args = ['chase'];
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null || value === false || value === '') continue;
          if (value === true) args.push(`--${key}`);
          else args.push(`--${key}`, String(value));
        }

        return new Promise((resolve) => {
          execFile('openbroker', args, { timeout: 600_000 }, (_err, stdout, stderr) => {
            resolve({ content: [{ type: 'text' as const, text: (stdout + (stderr || '')).trim() }] });
          });
        });
      },
    },

    // ── Watcher Tool ────────────────────────────────────────────

    {
      name: 'ob_watcher_status',
      description: 'Get the status of the background position watcher: tracked positions, margin usage, events detected',
      parameters: { type: 'object', properties: {} },
      async execute() {
        if (!watcher) {
          return json({ running: false, error: 'Watcher is not enabled' });
        }
        return json(watcher.getStatus());
      },
    },
  ];
}
