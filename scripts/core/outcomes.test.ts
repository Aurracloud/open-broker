import test from 'node:test';
import assert from 'node:assert/strict';
import { HyperliquidClient } from './client.js';
import type { OutcomeMetaResponse } from './types.js';
import type { OutcomeTemplate } from './outcome-templates.js';

const templates: OutcomeTemplate[] = [
  { id: 'sport', role: 'question', name: '{a} v {b}', description: 'Winner of {a} v {b}', keywords: [] },
  { id: 'team', role: { questionOutcome: { parent: 'sport' } }, name: '{team}', description: '{team} wins', keywords: [] },
  { id: 'price', role: { standaloneOutcome: { sideNames: ['Long', 'Short'] } }, name: '{perp} above {target}', description: 'Source: {source}', keywords: [] },
];
const meta: OutcomeMetaResponse = {
  outcomes: [
    { outcome: 12, name: 'template:team', description: 'team:Arsenal', sideSpecs: [{ name: 'Yes' }, { name: 'No' }], quoteToken: 'USDC', venue: 'out', deployerFeeScale: '1' },
    { outcome: 13, name: 'template:price', description: 'perp:xyz:ABC|target:10|source:https://example.com/$&', sideSpecs: [{ name: 'template:Long' }, { name: 'template:Short' }] },
  ],
  questions: [{ question: 1, name: 'template:sport', description: 'a:Arsenal|b:Chelsea', namedOutcomes: [12], fallbackOutcome: 11 }],
};

function clientStub() {
  const client = Object.create(HyperliquidClient.prototype) as HyperliquidClient;
  Object.assign(client, {
    verbose: false,
    config: { builderAddress: '0x0000000000000000000000000000000000000000', baseUrl: 'https://api.hyperliquid.xyz', slippageBps: 50 },
    getOutcomeMeta: async () => meta,
    getOutcomeTemplates: async () => templates,
    getSpotMeta: async () => ({ tokens: [] }),
    getOutcomeCtxMap: async () => new Map([['#120', { midPx: '0.7' }]]),
    requireTrading: async () => {},
  });
  return client;
}

test('market discovery decodes labels and question context while retaining raw parameters and identity', async () => {
  const markets = await clientStub().getOutcomeMarkets();
  assert.equal(markets[0].name, 'Arsenal');
  assert.equal(markets[0].question?.name, 'Arsenal v Chelsea');
  assert.equal(markets[0].sides[0].assetId, 100000120);
  assert.equal(markets[0].sides[0].midPx, '0.7');
  assert.equal(markets[0].quoteToken, 'USDC');
  assert.equal(markets[0].venue, 'out');
  assert.equal(markets[1].name, 'xyz:ABC above 10');
  assert.equal(markets[1].description, 'Source: https://example.com/$&');
  assert.equal(markets[1].parsedDescription.perp, 'xyz:ABC');
  assert.equal(markets[1].rawName, 'template:price');
  assert.deepEqual(markets[1].sides.map(s => s.name), ['Long', 'Short']);
  assert.equal(meta.outcomes[0].name, 'template:team');
});

test('unknown or incomplete templates fail clearly; legacy discovery does not request templates', async () => {
  const client = clientStub();
  client.getOutcomeTemplates = async () => [];
  await assert.rejects(client.getOutcomeMarkets(), /template unavailable/);
  client.getOutcomeTemplates = async () => templates;
  client.getOutcomeMeta = async () => ({ outcomes: [{ ...meta.outcomes[1], description: '' }] });
  await assert.rejects(client.getOutcomeMarkets(), /Missing/);
  client.getOutcomeMeta = async () => ({ outcomes: [{ ...meta.outcomes[0], name: 'Legacy' }] });
  client.getOutcomeTemplates = async () => { throw new Error('Must not fetch'); };
  assert.equal((await client.getOutcomeMarkets())[0].name, 'Legacy');
});

test('outcome references preserve side identity and reject malformed or conflicting ids', () => {
  const client = clientStub();
  assert.equal(client.resolveOutcomeRef('+121').assetId, 100000121);
  assert.equal(client.resolveOutcomeRef('12', 'no').coin, '#121');
  for (const value of ['12junk', '#120junk', '#122', '#-10', '-1', '1.2', '', '99999999999999999999', NaN, -1, 1.5]) {
    assert.throws(() => client.resolveOutcomeRef(value));
  }
  assert.throws(() => client.resolveOutcomeRef('#121', 'yes'), /conflicts/);
});

test('orders encode the intended side and constrain market prices without sending a real order', async () => {
  const client = clientStub();
  const requests: Array<{ orders: Array<{ a: number; p: string; s: string; t: { limit: { tif: string } } }> }> = [];
  Object.assign(client, { exchange: { order: async (request: typeof requests[number]) => { requests.push(request); return { status: 'ok' }; } } });
  await client.outcomeLimitOrder('#121', undefined, true, 10, 0.42);
  assert.equal(requests[0].orders[0].a, 100000121);
  assert.equal(+requests[0].orders[0].p, 0.42);
  client.getOutcomeMidPrice = async () => 0.9999;
  await client.outcomeMarketOrder(12, 'yes', true, 10, 50);
  assert.equal(+requests[1].orders[0].p, 0.99999);
  assert.equal(requests[1].orders[0].t.limit.tif, 'Ioc');
  for (const price of [NaN, Infinity, 0, 1, -1]) await assert.rejects(client.outcomeLimitOrder(12, 0, true, 10, price));
  for (const size of [NaN, Infinity, 0, 0.1]) await assert.rejects(client.outcomeLimitOrder(12, 0, true, size, 0.4));
  await assert.rejects(client.outcomeMarketOrder(12, 0, true, 10, -1), /slippage/);
  assert.equal(requests.length, 2);
});
