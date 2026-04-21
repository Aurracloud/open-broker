#!/usr/bin/env tsx
// Search Markets - Find specific assets across all providers (perps, HIP-3, spot)

import { getClient } from '../core/client.js';

interface Args {
  query: string;
  type?: 'perp' | 'spot' | 'hip3' | 'all';
  verbose?: boolean;
  json?: boolean;
}

function parseArgs(): Args {
  const args: Args = { query: '', type: 'all' };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--query' && process.argv[i + 1]) {
      args.query = process.argv[++i];
    } else if (arg === '--type' && process.argv[i + 1]) {
      const val = process.argv[++i].toLowerCase();
      if (['perp', 'spot', 'hip3', 'all'].includes(val)) {
        args.type = val as Args['type'];
      }
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Search Markets - Find assets across all Hyperliquid markets

Usage: npx tsx scripts/info/search-markets.ts --query <search> [options]

Options:
  --query <search>  Search term (required) - matches coin name
  --type <type>     Filter by market type: perp, spot, hip3, or all (default: all)
  --json            Output as JSON (machine-readable)
  --verbose         Show detailed output
  --help            Show this help

Examples:
  npx tsx scripts/info/search-markets.ts --query GOLD       # Find all GOLD markets
  npx tsx scripts/info/search-markets.ts --query BTC        # Find all BTC markets
  npx tsx scripts/info/search-markets.ts --query ETH --type perp  # ETH perps only
  npx tsx scripts/info/search-markets.ts --query PURR --type spot # PURR spot only
  npx tsx scripts/info/search-markets.ts --query HYPE --json      # JSON output
`);
      process.exit(0);
    } else if (!args.query && !arg.startsWith('-')) {
      // Allow query as positional arg
      args.query = arg;
    }
  }

  if (!args.query) {
    console.error('Error: --query is required');
    console.log('Usage: npx tsx scripts/info/search-markets.ts --query <search>');
    process.exit(1);
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

function formatFunding(rate: string): string {
  const r = parseFloat(rate);
  const annualized = r * 24 * 365 * 100;
  const sign = annualized >= 0 ? '+' : '';
  return `${sign}${annualized.toFixed(2)}%`;
}

async function main() {
  const args = parseArgs();
  const client = getClient();
  client.verbose = args.verbose ?? false;

  const query = args.query.toUpperCase();
  if (!args.json) {
    console.log(`Searching for "${query}" across all markets...\n`);
  }

  interface Result {
    type: 'perp' | 'spot' | 'hip3';
    provider: string;
    coin: string;
    assetId: number;
    price: string;
    volume24h: number;
    funding?: string;
    maxLeverage?: number;
    openInterest?: string;
  }

  const results: Result[] = [];

  // Search main perps
  if (args.type === 'all' || args.type === 'perp') {
    const meta = await client.getMetaAndAssetCtxs();
    for (let i = 0; i < meta.meta.universe.length; i++) {
      const asset = meta.meta.universe[i];
      const ctx = meta.assetCtxs[i];

      if (asset.name.toUpperCase().includes(query)) {
        results.push({
          type: 'perp',
          provider: 'Hyperliquid',
          coin: asset.name,
          assetId: i,
          price: ctx.markPx,
          volume24h: parseFloat(ctx.dayNtlVlm),
          funding: ctx.funding,
          maxLeverage: asset.maxLeverage,
          openInterest: ctx.openInterest,
        });
      }
    }
  }

  // Search HIP-3 perps
  if (args.type === 'all' || args.type === 'hip3') {
    if (client.isTestnet) {
      // On testnet, load specific dex if query is "dex:COIN" format
      if (args.query.includes(':')) {
        await client.loadSingleHip3Dex(args.query.split(':')[0]);
      } else if (!args.json) {
        console.log('  (Testnet: HIP-3 dexes not auto-loaded. Use "dexName:COIN" to search a specific dex.)\n');
      }
    }
    try {
      const allPerpMetas = await client.getAllPerpMetas();
      // Skip index 0 (main dex), process HIP-3 dexs
      for (let dexIdx = 1; dexIdx < allPerpMetas.length; dexIdx++) {
        const dexData = allPerpMetas[dexIdx];
        if (!dexData || !dexData.meta?.universe) continue;

        for (let i = 0; i < dexData.meta.universe.length; i++) {
          const asset = dexData.meta.universe[i];
          const ctx = dexData.assetCtxs[i];
          if (!asset || !ctx) continue;

          if (asset.name.toUpperCase().includes(query)) {
            let assetId = -1;
            try { assetId = client.getAssetIndex(asset.name); } catch { /* not registered */ }
            results.push({
              type: 'hip3',
              provider: dexData.dexName || `HIP-3 DEX ${dexIdx}`,
              coin: asset.name,
              assetId,
              price: ctx.markPx,
              volume24h: parseFloat(ctx.dayNtlVlm || '0'),
              funding: ctx.funding,
              maxLeverage: asset.maxLeverage,
              openInterest: ctx.openInterest,
            });
          }
        }
      }
    } catch (e) {
      if (args.verbose) console.error('Failed to fetch HIP-3 markets:', e);
    }
  }

  // Search spot markets
  if (args.type === 'all' || args.type === 'spot') {
    try {
      const spotData = await client.getSpotMetaAndAssetCtxs();

      // Build token index → name lookup for matching by base token name
      const tokenNameMap = new Map<number, string>();
      for (const token of spotData.meta.tokens) {
        tokenNameMap.set(token.index, token.name);
      }

      // Build ctx map by coin name (contexts have a 'coin' field that matches pair.name).
      // The contexts array can be longer than universe and is NOT aligned by index.
      const ctxMap = new Map<string, (typeof spotData.assetCtxs)[number]>();
      for (const ctx of spotData.assetCtxs) {
        if ((ctx as Record<string, unknown>).coin) {
          ctxMap.set((ctx as Record<string, unknown>).coin as string, ctx);
        }
      }

      for (const pair of spotData.meta.universe) {
        if (!pair) continue;
        const ctx = ctxMap.get(pair.name);
        if (!ctx) continue;

        // Match against pair name, base token name, and quote token name
        const baseTokenName = tokenNameMap.get(pair.tokens[0]) ?? '';
        const quoteTokenName = tokenNameMap.get(pair.tokens[1]) ?? '';
        const searchable = `${pair.name} ${baseTokenName} ${quoteTokenName}`.toUpperCase();

        if (searchable.includes(query)) {
          const displayName = baseTokenName && quoteTokenName
            ? `${baseTokenName}/${quoteTokenName}`
            : pair.name;
          results.push({
            type: 'spot',
            provider: 'Spot',
            coin: displayName,
            assetId: 10000 + pair.index,
            price: ctx.markPx,
            volume24h: parseFloat(ctx.dayNtlVlm || '0'),
          });
        }
      }
    } catch (e) {
      if (args.verbose) console.error('Failed to fetch spot markets:', e);
    }
  }

  // Sort by volume
  results.sort((a, b) => b.volume24h - a.volume24h);

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (results.length === 0) {
    console.log(`No markets found matching "${query}"`);
    return;
  }

  console.log(`Found ${results.length} market(s) matching "${query}":\n`);
  console.log('Type     Provider         Coin           AssetID    Price            24h Volume    Funding (Ann.)  OI');
  console.log('-'.repeat(112));

  for (const m of results) {
    const typeStr = m.type === 'hip3' ? 'HIP-3' : m.type.charAt(0).toUpperCase() + m.type.slice(1);
    const oi = m.openInterest ? formatVolume(parseFloat(m.openInterest)) : '-';
    console.log(
      `${typeStr.padEnd(8)} ${m.provider.padEnd(16)} ${m.coin.padEnd(14)} ${String(m.assetId).padStart(7)}    ${formatPrice(m.price).padStart(16)} ${formatVolume(m.volume24h).padStart(13)} ${(m.funding ? formatFunding(m.funding) : '-').padStart(14)} ${oi.padStart(10)}`
    );
  }

  // Show comparison if same asset on multiple providers
  const coinGroups = new Map<string, typeof results>();
  for (const r of results) {
    // Extract base asset name (strip /USDC, -PERP, etc.)
    const baseCoin = r.coin.replace(/[-\/].*/, '').toUpperCase();
    if (!coinGroups.has(baseCoin)) {
      coinGroups.set(baseCoin, []);
    }
    coinGroups.get(baseCoin)!.push(r);
  }

  // Show funding comparison for assets with multiple providers
  for (const [coin, markets] of coinGroups) {
    const perpsWithFunding = markets.filter((m) => m.funding && m.type !== 'spot');
    if (perpsWithFunding.length > 1) {
      console.log(`\n=== ${coin} Funding Comparison ===\n`);
      console.log('Provider         Coin           AssetID    Funding (Ann.)    Price');
      console.log('-'.repeat(78));
      for (const m of perpsWithFunding.sort((a, b) => parseFloat(b.funding!) - parseFloat(a.funding!))) {
        console.log(
          `${m.provider.padEnd(16)} ${m.coin.padEnd(14)} ${String(m.assetId).padStart(7)}    ${formatFunding(m.funding!).padStart(14)}    ${formatPrice(m.price)}`
        );
      }
    }
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
