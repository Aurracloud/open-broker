import assert from 'node:assert/strict';
import test from 'node:test';
import type { HyperliquidClient } from '../core/client.js';
import type { WebSocketManager, WsEventMap, WsEventType } from '../core/ws.js';
import { AutomationRealtimeData } from './realtime.js';

class FakeWebSocket {
  connected = true;
  private handlers = new Map<WsEventType, Set<(value: unknown) => void>>();

  on(event: WsEventType, handler: (value: unknown) => void): void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
  }

  emit<E extends WsEventType>(event: E, value: WsEventMap[E]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }

  async subscribeL2Book(coin: string): Promise<unknown> {
    queueMicrotask(() => this.emit('l2Book', {
      coin,
      time: Date.now(),
      levels: [
        [{ px: '99', sz: '2', n: 1 }],
        [{ px: '101', sz: '3', n: 1 }],
      ],
    }));
    return {};
  }
}

const ADDRESS = '0x0000000000000000000000000000000000000001';

test('realtime cache serves subscribed market/account data and seeds books on demand', async () => {
  const ws = new FakeWebSocket();
  const mergedState = {
    assetPositions: [],
    marginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0', withdrawable: '100' },
    crossMarginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0', withdrawable: '100' },
    crossMaintenanceMarginUsed: '0',
  };
  const client = {
    userStateAllFromWs: () => mergedState,
  } as unknown as HyperliquidClient;
  const cache = new AutomationRealtimeData(ws as unknown as WebSocketManager, client, ADDRESS, true);

  ws.emit('allMids', { mids: { HYPE: '100' } });
  ws.emit('allDexsAssetCtxs', { ctxs: [['', [{ funding: '0.0001', openInterest: '1', dayNtlVlm: '2', premium: '0', oraclePx: '100', markPx: '100', prevDayPx: '99' }]]] });
  ws.emit('spotState', { balances: [{ coin: 'USDC', token: 0, total: '100', hold: '0' }] });
  ws.emit('openOrders', { user: ADDRESS, dex: '', orders: [] });
  ws.emit('allDexsClearinghouseState', {
    user: ADDRESS,
    clearinghouseStates: [['', {
      assetPositions: [],
      marginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0', withdrawable: '100' },
      crossMarginSummary: { accountValue: '100', totalNtlPos: '0', totalRawUsd: '100', totalMarginUsed: '0', withdrawable: '100' },
      crossMaintenanceMarginUsed: '0',
      withdrawable: '100',
    }]],
  });

  assert.equal(await cache.waitUntilReady(20), true);
  assert.equal(cache.getAllMids()?.HYPE, '100');
  assert.equal(cache.getMainAssetCtxs()?.[0]?.funding, '0.0001');
  assert.equal(cache.getSpotBalances(ADDRESS)?.balances[0]?.entryNtl, '0');
  assert.deepEqual(cache.getOpenOrders(ADDRESS), []);
  assert.equal(cache.getUserState(ADDRESS)?.marginSummary.accountValue, '100');
  assert.equal(cache.getUserStateAll(ADDRESS)?.marginSummary.accountValue, '100');

  const book = await cache.getL2Book('HYPE');
  assert.equal(book?.levels[0][0]?.px, '99');
  assert.equal(book?.levels[1][0]?.px, '101');
});

test('realtime cache declines reads while disconnected so the client can fall back to REST', () => {
  const ws = new FakeWebSocket();
  const client = { userStateAllFromWs: () => null } as unknown as HyperliquidClient;
  const cache = new AutomationRealtimeData(ws as unknown as WebSocketManager, client, ADDRESS, false);
  ws.emit('allMids', { mids: { HYPE: '100' } });
  ws.connected = false;
  assert.equal(cache.getAllMids(), null);
});
