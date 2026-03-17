// Funding Arbitrage — Collect funding by positioning opposite to the crowd

import type { AutomationAPI, AutomationConfig } from '../types.js';

export const config: AutomationConfig = {
  description: 'Funding arbitrage — collect funding by positioning opposite to the crowd',
  fields: {
    coin:       { type: 'string', description: 'Asset to trade', default: 'HYPE' },
    sizeUsd:    { type: 'number', description: 'Position size in USD notional', default: 5000 },
    minFunding: { type: 'number', description: 'Min annualized % to enter', default: 20 },
    maxFunding: { type: 'number', description: 'Max annualized % — avoid squeezes', default: 200 },
    closeAt:    { type: 'number', description: 'Close when funding drops below this %', default: 5 },
  },
};

export default function fundingArb(api: AutomationAPI) {
  const COIN = api.state.get<string>('coin', 'HYPE')!;
  const SIZE_USD = api.state.get<number>('sizeUsd', 5000)!;
  const MIN_FUNDING = api.state.get<number>('minFunding', 20)!;
  const MAX_FUNDING = api.state.get<number>('maxFunding', 200)!;
  const CLOSE_AT = api.state.get<number>('closeAt', 5)!;

  let inPosition = api.state.get<boolean>('inPosition', false)!;
  let positionSide = api.state.get<string>('positionSide', '')!;
  let entryPrice = api.state.get<number>('entryPrice', 0)!;
  let positionSize = api.state.get<number>('positionSize', 0)!;
  let totalFunding = api.state.get<number>('totalFunding', 0)!;

  api.onStart(() => {
    api.log.info(`Funding arb: ${COIN} | $${SIZE_USD} | Enter >${MIN_FUNDING}% | Close <${CLOSE_AT}%`);
    if (inPosition) {
      api.log.info(`Resuming ${positionSide} position: ${positionSize.toFixed(6)} @ $${entryPrice.toFixed(2)}`);
    }
  });

  api.on('funding_update', async ({ coin, annualized }) => {
    if (coin !== COIN) return;

    const annualizedPct = annualized * 100;
    const absAnnualized = Math.abs(annualizedPct);

    if (inPosition) {
      // Check if we should close
      const shouldClose =
        (positionSide === 'short' && annualizedPct < CLOSE_AT) ||
        (positionSide === 'long' && annualizedPct > -CLOSE_AT);

      if (shouldClose) {
        api.log.info(`Funding dropped to ${annualizedPct.toFixed(2)}% (below ${CLOSE_AT}%), closing ${positionSide}`);
        const closeIsBuy = positionSide === 'short';
        await api.client.marketOrder(coin, closeIsBuy, positionSize);

        inPosition = false;
        api.state.set('inPosition', false);
        api.log.info(`Position closed. Funding collected: ~$${totalFunding.toFixed(2)}`);
      } else {
        api.log.debug(`${coin} funding: ${annualizedPct.toFixed(2)}% — holding ${positionSide}`);
      }
      return;
    }

    // Not in position — check if we should enter
    if (absAnnualized >= MIN_FUNDING && absAnnualized <= MAX_FUNDING) {
      const shouldShort = annualizedPct > 0; // Positive = longs pay shorts
      const side = shouldShort ? 'short' : 'long';

      const mids = await api.client.getAllMids();
      const price = parseFloat(mids[coin]);
      const size = SIZE_USD / price;

      api.log.info(`Funding at ${annualizedPct.toFixed(2)}% — opening ${side} ${size.toFixed(6)} ${coin}`);
      const response = await api.client.marketOrder(coin, !shouldShort, size);

      if (response.status === 'ok' && response.response && typeof response.response === 'object') {
        const status = response.response.data.statuses[0];
        if (status?.filled) {
          positionSize = parseFloat(status.filled.totalSz);
          entryPrice = parseFloat(status.filled.avgPx);
          positionSide = side;
          inPosition = true;

          api.state.set('inPosition', true);
          api.state.set('positionSide', side);
          api.state.set('entryPrice', entryPrice);
          api.state.set('positionSize', positionSize);

          api.log.info(`Entered ${side} ${positionSize.toFixed(6)} @ $${entryPrice.toFixed(2)}`);
        }
      }
    }
  });

  api.onStop(() => {
    if (inPosition) {
      api.log.warn(`Stopping with open ${positionSide} position of ${positionSize.toFixed(6)} ${COIN} — close manually if desired`);
    }
  });
}
