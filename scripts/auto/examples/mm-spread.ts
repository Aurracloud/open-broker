// Market Making (Spread) — Quote bid/ask around mid with inventory skewing

import type { AutomationAPI, AutomationConfig } from '../types.js';

export const config: AutomationConfig = {
  description: 'Market making — quote bid/ask around mid price with inventory skewing',
  fields: {
    coin:        { type: 'string', description: 'Asset to market make', default: 'HYPE' },
    size:        { type: 'number', description: 'Order size on each side (base asset)', default: 0.1 },
    spreadBps:   { type: 'number', description: 'Spread in bps from mid price', default: 10 },
    maxPosition: { type: 'number', description: 'Max net position before pausing side (default: 3x size)', default: 0.3 },
    skewFactor:  { type: 'number', description: 'Inventory skew aggressiveness', default: 2.0 },
  },
};

export default function mmSpread(api: AutomationAPI) {
  const COIN = api.state.get<string>('coin', 'HYPE')!;
  const SIZE = api.state.get<number>('size', 0.1)!;
  const SPREAD_BPS = api.state.get<number>('spreadBps', 10)!;
  const MAX_POS = api.state.get<number>('maxPosition', SIZE * 3)!;
  const SKEW = api.state.get<number>('skewFactor', 2.0)!;

  let bidOid: number | undefined;
  let askOid: number | undefined;
  let bidPrice = 0;
  let askPrice = 0;
  let totalBought = 0;
  let totalSold = 0;
  let totalBuyCost = 0;
  let totalSellRevenue = 0;

  const halfSpread = SPREAD_BPS / 10000 / 2;

  api.onStart(() => {
    api.log.info(`MM Spread: ${COIN} | ${SIZE}/side | ${SPREAD_BPS}bps | Max: ±${MAX_POS}`);
  });

  api.on('tick', async () => {
    const mids = await api.client.getAllMids();
    const mid = parseFloat(mids[COIN]);
    if (!mid) return;

    // Get position
    const userState = await api.client.getUserState();
    const pos = userState.assetPositions.find(p => p.position.coin === COIN);
    const position = pos ? parseFloat(pos.position.szi) : 0;

    // Check fills
    const openOrders = await api.client.getOpenOrders();
    const openOids = new Set(openOrders.filter(o => o.coin === COIN).map(o => o.oid));

    if (bidOid && !openOids.has(bidOid)) {
      totalBought += SIZE;
      totalBuyCost += bidPrice * SIZE;
      api.log.info(`BID FILLED @ ${api.utils.formatUsd(bidPrice)} | Pos: ${position.toFixed(4)}`);
      bidOid = undefined;
    }
    if (askOid && !openOids.has(askOid)) {
      totalSold += SIZE;
      totalSellRevenue += askPrice * SIZE;
      api.log.info(`ASK FILLED @ ${api.utils.formatUsd(askPrice)} | Pos: ${position.toFixed(4)}`);
      askOid = undefined;
    }

    // Inventory skew
    const ratio = Math.max(-1, Math.min(1, position / MAX_POS));
    const bidSkew = halfSpread * (1 + ratio * SKEW);
    const askSkew = halfSpread * (1 - ratio * SKEW);

    const targetBid = mid * (1 - Math.max(0.0001, bidSkew));
    const targetAsk = mid * (1 + Math.max(0.0001, askSkew));

    const shouldBid = position < MAX_POS;
    const shouldAsk = position > -MAX_POS;

    // Cancel stale quotes
    if (bidOid) {
      const drift = Math.abs(bidPrice - targetBid) / mid;
      if (drift > 0.001 || !shouldBid) {
        try { await api.client.cancel(COIN, bidOid); } catch { /* */ }
        bidOid = undefined;
      }
    }
    if (askOid) {
      const drift = Math.abs(askPrice - targetAsk) / mid;
      if (drift > 0.001 || !shouldAsk) {
        try { await api.client.cancel(COIN, askOid); } catch { /* */ }
        askOid = undefined;
      }
    }

    // Place new quotes
    if (shouldBid && !bidOid) {
      const resp = await api.client.limitOrder(COIN, true, SIZE, targetBid, 'Gtc', false);
      if (resp.status === 'ok' && resp.response && typeof resp.response === 'object') {
        const s = resp.response.data.statuses[0];
        if (s?.resting) { bidOid = s.resting.oid; bidPrice = targetBid; }
      }
    }
    if (shouldAsk && !askOid) {
      const resp = await api.client.limitOrder(COIN, false, SIZE, targetAsk, 'Gtc', false);
      if (resp.status === 'ok' && resp.response && typeof resp.response === 'object') {
        const s = resp.response.data.statuses[0];
        if (s?.resting) { askOid = s.resting.oid; askPrice = targetAsk; }
      }
    }
  });

  api.onStop(async () => {
    if (bidOid) try { await api.client.cancel(COIN, bidOid); } catch { /* */ }
    if (askOid) try { await api.client.cancel(COIN, askOid); } catch { /* */ }
    const pnl = totalSellRevenue - totalBuyCost;
    api.log.info(`MM stopped. Bought: ${totalBought.toFixed(6)} | Sold: ${totalSold.toFixed(6)} | PnL: ${api.utils.formatUsd(pnl)}`);
  });
}
