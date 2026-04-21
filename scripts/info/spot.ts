#!/usr/bin/env tsx
// Spot Markets - View spot markets and balances

import { getClient } from '../core/client.js';

interface Args {
  coin?: string;
  balances?: boolean;
  top?: number;
  verbose?: boolean;
  address?: string;
  json?: boolean;
}

function parseArgs(): Args {
  const args: Args = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--coin' && process.argv[i + 1]) {
      args.coin = process.argv[++i].toUpperCase();
    } else if (arg === '--balances') {
      args.balances = true;
    } else if (arg === '--top' && process.argv[i + 1]) {
      args.top = parseInt(process.argv[++i], 10);
    } else if (arg === '--address' && process.argv[i + 1]) {
      args.address = process.argv[++i].toLowerCase();
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Spot Markets - View Hyperliquid spot markets and balances

Usage: npx tsx scripts/info/spot.ts [options]

Options:
  --coin <symbol>      Filter by coin symbol
  --balances           Show your spot token balances
  --address <0x...>    Look up another account's spot balances (with --balances)
  --top <n>            Show only top N markets by volume
  --json               Output as JSON (machine-readable)
  --verbose            Show detailed output
  --help               Show this help

Examples:
  npx tsx scripts/info/spot.ts                  # Show all spot markets
  npx tsx scripts/info/spot.ts --coin PURR     # Show PURR market info
  npx tsx scripts/info/spot.ts --balances      # Show your spot balances
  npx tsx scripts/info/spot.ts --top 20        # Show top 20 by volume
`);
      process.exit(0);
    }
  }

  return args;
}

function formatVolume(vol: number): string {
  if (vol >= 1_000_000_000) return `$${(vol / 1_000_000_000).toFixed(2)}B`;
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(2)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(2)}K`;
  return `$${vol.toFixed(2)}`;
}

function formatPrice(price: string | number): string {
  const p = typeof price === 'string' ? parseFloat(price) : price;
  if (p >= 1000) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(6);
  return p.toFixed(8);
}

function formatChange(current: string, prev: string): string {
  const c = parseFloat(current);
  const p = parseFloat(prev);
  if (p === 0) return '-';
  const change = ((c - p) / p) * 100;
  const sign = change >= 0 ? '+' : '';
  return `${sign}${change.toFixed(2)}%`;
}

async function main() {
  const args = parseArgs();
  const client = getClient();
  client.verbose = args.verbose ?? false;

  // Show balances
  if (args.balances) {
    const lookupAddress = args.address ?? client.address;
    if (!args.json) console.log(`Fetching spot balances for ${lookupAddress}...\n`);

    const balances = await client.getSpotBalances(args.address);

    if (args.json) {
      console.log(JSON.stringify(balances.balances ?? [], null, 2));
      return;
    }

    if (!balances.balances || balances.balances.length === 0) {
      console.log('No spot token balances found.');
      return;
    }

    console.log('=== Spot Balances ===\n');
    console.log('Token          Total              Hold               Entry Value');
    console.log('-'.repeat(70));

    for (const b of balances.balances) {
      const total = parseFloat(b.total);
      const hold = parseFloat(b.hold);
      const entry = parseFloat(b.entryNtl);
      if (total === 0) continue;

      console.log(
        `${b.coin.padEnd(14)} ${total.toFixed(6).padStart(18)} ${hold.toFixed(6).padStart(18)} ${formatVolume(entry).padStart(15)}`
      );
    }
    return;
  }

  // Show markets
  if (!args.json) console.log('Fetching spot market data...\n');

  const spotData = await client.getSpotMetaAndAssetCtxs();

  interface SpotMarket {
    name: string;
    index: number;
    assetId: number;
    price: string;
    volume24h: number;
    change24h: string;
    tokens: [number, number];
    base?: string;
    quote?: string;
  }

  const markets: SpotMarket[] = [];

  // Build ctx map by coin name — the contexts array is NOT aligned with universe by index.
  // Each context has a 'coin' field matching pair.name.
  const ctxMap = new Map<string, { markPx: string; prevDayPx: string; dayNtlVlm: string; midPx: string }>();
  for (const ctx of spotData.assetCtxs as Array<{ coin?: string; markPx: string; prevDayPx: string; dayNtlVlm: string; midPx: string }>) {
    if (ctx.coin) ctxMap.set(ctx.coin, ctx);
  }

  // Build token name map for filtering by base token name
  const tokenNameMap = new Map<number, string>();
  for (const token of spotData.meta.tokens) {
    tokenNameMap.set(token.index, token.name);
  }

  for (const pair of spotData.meta.universe) {
    if (!pair) continue;
    const ctx = ctxMap.get(pair.name);
    if (!ctx) continue;

    // Filter by coin — match pair name or base token name
    if (args.coin) {
      const baseTokenName = tokenNameMap.get(pair.tokens[0]) ?? '';
      const searchable = `${pair.name} ${baseTokenName}`.toUpperCase();
      if (!searchable.includes(args.coin)) continue;
    }

    markets.push({
      name: pair.name,
      index: pair.index,
      assetId: 10000 + pair.index,
      price: ctx.markPx,
      volume24h: parseFloat(ctx.dayNtlVlm || '0'),
      change24h: formatChange(ctx.markPx, ctx.prevDayPx),
      tokens: pair.tokens,
      base: tokenNameMap.get(pair.tokens[0]),
      quote: tokenNameMap.get(pair.tokens[1]),
    });
  }

  // Sort by volume
  markets.sort((a, b) => b.volume24h - a.volume24h);

  // Apply top filter
  const displayMarkets = args.top ? markets.slice(0, args.top) : markets;

  if (args.json) {
    console.log(JSON.stringify(displayMarkets, null, 2));
    return;
  }

  if (displayMarkets.length === 0) {
    console.log(args.coin ? `No spot markets found for "${args.coin}"` : 'No spot markets found');
    return;
  }

  // Get token info for detailed display
  const tokenMap = new Map<number, { name: string; tokenId: string }>();
  for (const token of spotData.meta.tokens) {
    tokenMap.set(token.index, { name: token.name, tokenId: token.tokenId });
  }

  console.log(`=== Spot Markets (${displayMarkets.length} total) ===\n`);
  console.log('Pair           AssetID    Price            24h Volume    24h Change   Base/Quote');
  console.log('-'.repeat(92));

  for (const m of displayMarkets) {
    const baseToken = tokenMap.get(m.tokens[0]);
    const quoteToken = tokenMap.get(m.tokens[1]);
    const pairStr = `${baseToken?.name || '?'}/${quoteToken?.name || '?'}`;

    console.log(
      `${m.name.padEnd(14)} ${String(m.assetId).padStart(7)}    ${formatPrice(m.price).padStart(16)} ${formatVolume(m.volume24h).padStart(13)} ${m.change24h.padStart(11)}   ${pairStr}`
    );
  }

  // Show tokens if verbose
  if (args.verbose) {
    console.log('\n=== Tokens ===\n');
    console.log('Name           Token ID         Decimals');
    console.log('-'.repeat(50));
    for (const token of spotData.meta.tokens) {
      console.log(
        `${token.name.padEnd(14)} ${token.tokenId.padEnd(16)} sz=${token.szDecimals}, wei=${token.weiDecimals}`
      );
    }
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
