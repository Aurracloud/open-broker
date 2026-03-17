// Grid Trading — Place buy/sell orders at evenly spaced price levels

import type { AutomationAPI, AutomationConfig } from '../types.js';

export const config: AutomationConfig = {
  description: 'Grid trading — buy/sell orders at evenly spaced price levels',
  fields: {
    coin:  { type: 'string', description: 'Asset to trade', default: 'HYPE' },
    lower: { type: 'number', description: 'Lower price bound (default: auto -5% from mid)', default: 0 },
    upper: { type: 'number', description: 'Upper price bound (default: auto +5% from mid)', default: 0 },
    grids: { type: 'number', description: 'Number of grid levels', default: 10 },
    size:  { type: 'number', description: 'Size per level in base asset', default: 0.1 },
    mode:  { type: 'string', description: 'Grid mode: neutral, long, or short', default: 'neutral' },
  },
};

interface GridLevel {
  price: number;
  side: 'buy' | 'sell';
  size: number;
  oid?: number;
}

export default function grid(api: AutomationAPI) {
  const COIN = api.state.get<string>('coin', 'HYPE')!;
  const GRIDS = api.state.get<number>('grids', 10)!;
  const SIZE = api.state.get<number>('size', 0.1)!;
  const MODE = api.state.get<string>('mode', 'neutral')!;

  let levels: GridLevel[] = [];
  let realizedPnl = api.state.get<number>('realizedPnl', 0)!;
  let initialized = false;

  api.onStart(async () => {
    const mids = await api.client.getAllMids();
    const mid = parseFloat(mids[COIN]);
    if (!mid) {
      api.log.error(`No price for ${COIN}`);
      return;
    }

    const lower = api.state.get<number>('lower', mid * 0.95)!;
    const upper = api.state.get<number>('upper', mid * 1.05)!;
    const spacing = (upper - lower) / (GRIDS - 1);

    api.log.info(`Grid: ${COIN} ${api.utils.formatUsd(lower)}-${api.utils.formatUsd(upper)} | ${GRIDS} levels | ${SIZE}/level | ${MODE}`);

    // Build and place grid
    for (let i = 0; i < GRIDS; i++) {
      const price = lower + spacing * i;
      let side: 'buy' | 'sell';
      if (MODE === 'long') side = 'buy';
      else if (MODE === 'short') side = 'sell';
      else side = price < mid ? 'buy' : 'sell';

      // Skip levels too close to mid
      if (Math.abs(price - mid) / mid < 0.001) continue;

      const level: GridLevel = { price, side, size: SIZE };

      const response = await api.client.limitOrder(COIN, side === 'buy', SIZE, price, 'Gtc', false);
      if (response.status === 'ok' && response.response && typeof response.response === 'object') {
        const status = response.response.data.statuses[0];
        if (status?.resting) {
          level.oid = status.resting.oid;
          api.log.info(`${side.toUpperCase()} @ ${api.utils.formatUsd(price)} — OID: ${level.oid}`);
        } else if (status?.filled) {
          api.log.info(`${side.toUpperCase()} @ ${api.utils.formatUsd(price)} — filled immediately`);
        }
      }

      levels.push(level);
      await api.utils.sleep(100);
    }

    initialized = true;
    api.log.info(`Grid initialized: ${levels.filter(l => l.oid).length} open orders`);
  });

  // Monitor fills and replace with opposite orders
  api.on('tick', async () => {
    if (!initialized || levels.length === 0) return;

    const openOrders = await api.client.getOpenOrders();
    const openOids = new Set(openOrders.filter(o => o.coin === COIN).map(o => o.oid));

    const mids = await api.client.getAllMids();
    const mid = parseFloat(mids[COIN]);
    const lower = api.state.get<number>('lower', mid * 0.95)!;
    const upper = api.state.get<number>('upper', mid * 1.05)!;
    const spacing = (upper - lower) / (GRIDS - 1);

    for (const level of levels) {
      if (!level.oid || openOids.has(level.oid)) continue;

      // Order was filled
      api.log.info(`${level.side.toUpperCase()} FILLED @ ${api.utils.formatUsd(level.price)}`);
      level.oid = undefined;

      if (MODE !== 'neutral') continue;

      // Place opposite order
      const oppositeSide = level.side === 'buy' ? 'sell' : 'buy';
      const oppositePrice = level.side === 'buy' ? level.price + spacing : level.price - spacing;

      if (oppositePrice < lower || oppositePrice > upper) continue;

      const response = await api.client.limitOrder(COIN, oppositeSide === 'buy', SIZE, oppositePrice, 'Gtc', false);
      if (response.status === 'ok' && response.response && typeof response.response === 'object') {
        const status = response.response.data.statuses[0];
        if (status?.resting) {
          const newLevel: GridLevel = { price: oppositePrice, side: oppositeSide, size: SIZE, oid: status.resting.oid };
          levels.push(newLevel);

          if (level.side === 'buy') {
            realizedPnl += (oppositePrice - level.price) * SIZE;
          }

          api.state.set('realizedPnl', realizedPnl);
          api.log.info(`Placed ${oppositeSide.toUpperCase()} @ ${api.utils.formatUsd(oppositePrice)} | PnL: ${api.utils.formatUsd(realizedPnl)}`);
        }
      }
    }
  });

  api.onStop(async () => {
    api.log.info('Cancelling grid orders...');
    for (const level of levels) {
      if (level.oid) {
        try { await api.client.cancel(COIN, level.oid); } catch { /* may be filled */ }
      }
    }
    api.log.info(`Grid stopped. Realized PnL: ${api.utils.formatUsd(realizedPnl)}`);
  });
}
