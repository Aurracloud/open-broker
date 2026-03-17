// DCA (Dollar Cost Averaging) — Buy fixed USD amounts at regular intervals

import type { AutomationAPI, AutomationConfig } from '../types.js';

export const config: AutomationConfig = {
  description: 'Dollar cost averaging — buy fixed USD amounts at regular intervals',
  fields: {
    coin:     { type: 'string', description: 'Asset to accumulate', default: 'HYPE' },
    amount:   { type: 'number', description: 'USD per purchase', default: 100 },
    interval: { type: 'number', description: 'Milliseconds between buys (3600000 = 1h)', default: 3_600_000 },
    count:    { type: 'number', description: 'Total number of purchases', default: 24 },
  },
};

export default function dca(api: AutomationAPI) {
  const COIN = api.state.get<string>('coin', 'HYPE')!;
  const AMOUNT_USD = api.state.get<number>('amount', 100)!;
  const INTERVAL_MS = api.state.get<number>('interval', 3_600_000)!;
  const MAX_PURCHASES = api.state.get<number>('count', 24)!;

  let purchased = api.state.get<number>('purchased', 0)!;
  let totalSpent = api.state.get<number>('totalSpent', 0)!;
  let totalAcquired = api.state.get<number>('totalAcquired', 0)!;

  api.onStart(() => {
    api.log.info(`DCA: ${MAX_PURCHASES} buys of $${AMOUNT_USD} ${COIN} every ${INTERVAL_MS / 60000}m`);
    api.log.info(`Progress: ${purchased}/${MAX_PURCHASES} completed`);
  });

  api.every(INTERVAL_MS, async () => {
    if (purchased >= MAX_PURCHASES) {
      api.log.info(`DCA complete: ${purchased} purchases, $${totalSpent.toFixed(2)} spent, ${totalAcquired.toFixed(6)} ${COIN} acquired`);
      return;
    }

    const mids = await api.client.getAllMids();
    const price = parseFloat(mids[COIN]);
    if (!price) {
      api.log.warn(`No price for ${COIN}, skipping`);
      return;
    }

    const size = AMOUNT_USD / price;
    api.log.info(`[${purchased + 1}/${MAX_PURCHASES}] Buying ~$${AMOUNT_USD} of ${COIN} @ $${price.toFixed(2)}`);

    const response = await api.client.marketOrder(COIN, true, size);
    if (response.status === 'ok' && response.response && typeof response.response === 'object') {
      const status = response.response.data.statuses[0];
      if (status?.filled) {
        const filledSize = parseFloat(status.filled.totalSz);
        const avgPx = parseFloat(status.filled.avgPx);
        totalSpent += filledSize * avgPx;
        totalAcquired += filledSize;
        purchased++;

        api.state.set('purchased', purchased);
        api.state.set('totalSpent', totalSpent);
        api.state.set('totalAcquired', totalAcquired);

        const avgPrice = totalSpent / totalAcquired;
        api.log.info(`Filled ${filledSize.toFixed(6)} @ $${avgPx.toFixed(2)} | Avg: $${avgPrice.toFixed(2)} | Total: ${totalAcquired.toFixed(6)} ${COIN}`);
      } else if (status?.error) {
        api.log.error(`Order failed: ${status.error}`);
      }
    }
  });

  api.onStop(() => {
    const avgPrice = totalAcquired > 0 ? totalSpent / totalAcquired : 0;
    api.log.info(`DCA stopped: ${purchased}/${MAX_PURCHASES} | Spent: $${totalSpent.toFixed(2)} | Acquired: ${totalAcquired.toFixed(6)} ${COIN} | Avg: $${avgPrice.toFixed(2)}`);
  });
}
