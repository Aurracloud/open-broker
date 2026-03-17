// Maker-Only Market Making — ALO orders that guarantee maker rebates

import type { AutomationAPI, AutomationConfig } from '../types.js';

export const config: AutomationConfig = {
  description: 'Maker-only market making — ALO orders for guaranteed maker rebates',
  fields: {
    coin:        { type: 'string', description: 'Asset to market make', default: 'HYPE' },
    size:        { type: 'number', description: 'Order size on each side (base asset)', default: 0.1 },
    offsetBps:   { type: 'number', description: 'Offset from best bid/ask in bps', default: 1 },
    maxPosition: { type: 'number', description: 'Max net position (default: 3x size)', default: 0.3 },
    skewFactor:  { type: 'number', description: 'Inventory skew aggressiveness', default: 2.0 },
  },
};

export default function mmMaker(api: AutomationAPI) {
  const COIN = api.state.get<string>('coin', 'HYPE')!;
  const SIZE = api.state.get<number>('size', 0.1)!;
  const OFFSET_BPS = api.state.get<number>('offsetBps', 1)!;
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
  let rejections = 0;

  const offsetFraction = OFFSET_BPS / 10000;

  api.onStart(() => {
    api.log.info(`Maker MM: ${COIN} | ${SIZE}/side | ${OFFSET_BPS}bps offset | ALO only`);
  });

  api.on('tick', async () => {
    const book = await api.client.getL2Book(COIN);
    if (book.bestBid === 0 || book.bestAsk === 0) return;

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
      api.log.info(`BID FILLED @ ${api.utils.formatUsd(bidPrice)} | Pos: ${position.toFixed(4)} | +rebate`);
      bidOid = undefined;
    }
    if (askOid && !openOids.has(askOid)) {
      totalSold += SIZE;
      totalSellRevenue += askPrice * SIZE;
      api.log.info(`ASK FILLED @ ${api.utils.formatUsd(askPrice)} | Pos: ${position.toFixed(4)} | +rebate`);
      askOid = undefined;
    }

    // Inventory skew
    const ratio = Math.max(-1, Math.min(1, position / MAX_POS));
    const bidSkewMult = 1 + ratio * SKEW;
    const askSkewMult = 1 - ratio * SKEW;

    const targetBid = book.bestBid * (1 - offsetFraction * Math.max(0.1, bidSkewMult));
    const targetAsk = book.bestAsk * (1 + offsetFraction * Math.max(0.1, askSkewMult));

    // Ensure no crossing
    const safeBid = Math.min(targetBid, book.bestAsk * 0.9999);
    const safeAsk = Math.max(targetAsk, book.bestBid * 1.0001);

    const shouldBid = position < MAX_POS;
    const shouldAsk = position > -MAX_POS;

    // Cancel stale quotes
    if (bidOid) {
      const drift = Math.abs(bidPrice - safeBid) / book.midPrice;
      if (drift > 0.0005 || !shouldBid) {
        try { await api.client.cancel(COIN, bidOid); } catch { /* */ }
        bidOid = undefined;
      }
    }
    if (askOid) {
      const drift = Math.abs(askPrice - safeAsk) / book.midPrice;
      if (drift > 0.0005 || !shouldAsk) {
        try { await api.client.cancel(COIN, askOid); } catch { /* */ }
        askOid = undefined;
      }
    }

    // Place ALO bid
    if (shouldBid && !bidOid && safeBid < book.bestAsk) {
      const resp = await api.client.limitOrder(COIN, true, SIZE, safeBid, 'Alo', false);
      if (resp.status === 'ok' && resp.response && typeof resp.response === 'object') {
        const s = resp.response.data.statuses[0];
        if (s?.resting) { bidOid = s.resting.oid; bidPrice = safeBid; }
        else if (s?.error) { rejections++; }
      }
    }

    // Place ALO ask
    if (shouldAsk && !askOid && safeAsk > book.bestBid) {
      const resp = await api.client.limitOrder(COIN, false, SIZE, safeAsk, 'Alo', false);
      if (resp.status === 'ok' && resp.response && typeof resp.response === 'object') {
        const s = resp.response.data.statuses[0];
        if (s?.resting) { askOid = s.resting.oid; askPrice = safeAsk; }
        else if (s?.error) { rejections++; }
      }
    }
  });

  api.onStop(async () => {
    if (bidOid) try { await api.client.cancel(COIN, bidOid); } catch { /* */ }
    if (askOid) try { await api.client.cancel(COIN, askOid); } catch { /* */ }
    const pnl = totalSellRevenue - totalBuyCost;
    const volume = totalBuyCost + totalSellRevenue;
    const rebates = volume * 0.00003;
    api.log.info(`Maker MM stopped. PnL: ${api.utils.formatUsd(pnl)} | Rebates: ~${api.utils.formatUsd(rebates)} | Rejections: ${rejections}`);
  });
}
