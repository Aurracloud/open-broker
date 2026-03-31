// Price Alert — Real-time price monitoring via WebSocket
// Showcases WebSocket-driven price_change and order_update events

import type { AutomationAPI, AutomationConfig } from '../types.js';

export const config: AutomationConfig = {
  description: 'Real-time price alerts via WebSocket — log price moves and order updates',
  fields: {
    coin:      { type: 'string',  description: 'Asset to monitor', default: 'BTC' },
    threshold: { type: 'number',  description: 'Min price change % to alert on', default: 0.1 },
    above:     { type: 'number',  description: 'Alert when price goes above this level (0 = disabled)', default: 0 },
    below:     { type: 'number',  description: 'Alert when price goes below this level (0 = disabled)', default: 0 },
  },
};

export default function priceAlert(api: AutomationAPI) {
  const COIN = api.state.get<string>('coin', 'BTC')!;
  const THRESHOLD = api.state.get<number>('threshold', 0.1)!;
  const ABOVE = api.state.get<number>('above', 0)!;
  const BELOW = api.state.get<number>('below', 0)!;

  let alertCount = 0;
  let lastAlertPrice = 0;
  let aboveTriggered = false;
  let belowTriggered = false;

  api.onStart(() => {
    api.log.info(`Monitoring ${COIN} via WebSocket`);
    api.log.info(`Threshold: ${THRESHOLD}% change`);
    if (ABOVE > 0) api.log.info(`Alert above: $${ABOVE}`);
    if (BELOW > 0) api.log.info(`Alert below: $${BELOW}`);
  });

  // Real-time price changes via WebSocket
  api.on('price_change', ({ coin, oldPrice, newPrice, changePct }) => {
    if (coin !== COIN) return;

    // Threshold alerts — fires when move exceeds configured %
    if (Math.abs(changePct) >= THRESHOLD) {
      const dir = changePct > 0 ? 'UP' : 'DOWN';
      api.log.info(`${COIN} ${dir} ${changePct.toFixed(3)}%: $${oldPrice.toFixed(2)} -> $${newPrice.toFixed(2)}`);
      alertCount++;
      lastAlertPrice = newPrice;
    }

    // Level alerts — fires once when price crosses a level, resets when it crosses back
    if (ABOVE > 0) {
      if (newPrice >= ABOVE && !aboveTriggered) {
        aboveTriggered = true;
        api.log.info(`${COIN} ABOVE $${ABOVE}: now $${newPrice.toFixed(2)}`);
        api.publish(`${COIN} broke above $${ABOVE} — now $${newPrice.toFixed(2)}`, { name: 'price-alert' });
      } else if (newPrice < ABOVE) {
        aboveTriggered = false;
      }
    }

    if (BELOW > 0) {
      if (newPrice <= BELOW && !belowTriggered) {
        belowTriggered = true;
        api.log.info(`${COIN} BELOW $${BELOW}: now $${newPrice.toFixed(2)}`);
        api.publish(`${COIN} dropped below $${BELOW} — now $${newPrice.toFixed(2)}`, { name: 'price-alert' });
      } else if (newPrice > BELOW) {
        belowTriggered = false;
      }
    }
  });

  // Real-time order lifecycle via WebSocket
  api.on('order_update', ({ coin, oid, side, size, price, status }) => {
    if (status === 'filled') {
      api.log.info(`ORDER FILLED: ${side.toUpperCase()} ${size} ${coin} @ $${price.toFixed(2)} (oid: ${oid})`);
    } else if (status === 'canceled' || status.includes('Canceled') || status.includes('Rejected')) {
      api.log.warn(`ORDER ${status.toUpperCase()}: ${side} ${size} ${coin} @ $${price.toFixed(2)} (oid: ${oid})`);
    }
  });

  // Liquidation alerts via WebSocket
  api.on('liquidation', ({ liquidatedNtlPos, liquidatedAccountValue }) => {
    api.log.error(`LIQUIDATION: $${liquidatedNtlPos.toFixed(2)} notional, account value: $${liquidatedAccountValue.toFixed(2)}`);
    api.publish(
      `LIQUIDATED: $${liquidatedNtlPos.toFixed(2)} notional, account value: $${liquidatedAccountValue.toFixed(2)}`,
      { name: 'liquidation-alert' },
    );
  });

  // Periodic summary via REST heartbeat
  api.on('tick', ({ pollCount }) => {
    if (pollCount % 10 === 0 && alertCount > 0) {
      api.log.info(`Summary: ${alertCount} alerts fired, last price: $${lastAlertPrice.toFixed(2)}`);
    }
  });

  api.onStop(() => {
    api.log.info(`Stopped. Total alerts: ${alertCount}`);
  });
}
