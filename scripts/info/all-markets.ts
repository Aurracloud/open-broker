#!/usr/bin/env tsx
// All Markets - View all available markets across perps, spot, and HIP-3 dexs

import { getClient } from '../core/client.js';

interface Args {
  type?: 'perp' | 'spot' | 'hip3' | 'all';
  top?: number;
  verbose?: boolean;
  json?: boolean;
}

function parseArgs(): Args {
  const args: Args = { type: 'all' };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--type' && process.argv[i + 1]) {
      const val = process.argv[++i].toLowerCase();
      if (['perp', 'spot', 'hip3', 'all'].includes(val)) {
        args.type = val as Args['type'];
      }
    } else if (arg === '--top' && process.argv[i + 1]) {
      args.top = parseInt(process.argv[++i], 10);
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
All Markets - View all available markets on Hyperliquid

Usage: npx tsx scripts/info/all-markets.ts [options]

Options:
  --type <type>    Market type: perp, spot, hip3, or all (default: all)
  --top <n>        Show only top N markets by volume
  --json           Output as JSON (machine-readable)
  --verbose        Show detailed output
  --help           Show this help

Examples:
  npx tsx scripts/info/all-markets.ts                 # Show all markets
  npx tsx scripts/info/all-markets.ts --type perp    # Show only main perps
  npx tsx scripts/info/all-markets.ts --type hip3    # Show only HIP-3 perps
  npx tsx scripts/info/all-markets.ts --type spot    # Show only spot markets
  npx tsx scripts/info/all-markets.ts --top 20       # Show top 20 by volume
  npx tsx scripts/info/all-markets.ts --json         # JSON output
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

function formatFunding(rate: string): string {
  const r = parseFloat(rate);
  const annualized = r * 24 * 365 * 100;
  const sign = annualized >= 0 ? '+' : '';
  return `${sign}${annualized.toFixed(2)}%`;
}

interface MarketRow {
  type: 'perp' | 'spot' | 'hip3';
  provider: string;
  coin: string;
  assetId: number;
  price: string;
  volume24h: number;
  funding?: string;
  maxLeverage?: number;
}

async function main() {
  const args = parseArgs();
  const client = getClient();
  client.verbose = args.verbose ?? false;

  if (!args.json) {
    console.log('Fetching market data...\n');
  }

  const allMarkets: MarketRow[] = [];

  // Fetch main perps
  if (args.type === 'all' || args.type === 'perp') {
    const meta = await client.getMetaAndAssetCtxs();
    for (let i = 0; i < meta.meta.universe.length; i++) {
      const asset = meta.meta.universe[i];
      const ctx = meta.assetCtxs[i];
      allMarkets.push({
        type: 'perp',
        provider: 'Hyperliquid',
        coin: asset.name,
        assetId: i,
        price: ctx.markPx,
        volume24h: parseFloat(ctx.dayNtlVlm),
        funding: ctx.funding,
        maxLeverage: asset.maxLeverage,
      });
    }
  }

  // Fetch HIP-3 perps
  if (args.type === 'all' || args.type === 'hip3') {
    if (client.isTestnet && !args.json) {
      console.log('Note: Testnet — HIP-3 dexes not auto-loaded. Use "dexName:COIN" syntax to load a specific dex.\n');
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

          let assetId = -1;
          try { assetId = client.getAssetIndex(asset.name); } catch { /* not registered */ }
          allMarkets.push({
            type: 'hip3',
            provider: dexData.dexName || `HIP-3 DEX ${dexIdx}`,
            coin: asset.name,
            assetId,
            price: ctx.markPx,
            volume24h: parseFloat(ctx.dayNtlVlm || '0'),
            funding: ctx.funding,
            maxLeverage: asset.maxLeverage,
          });
        }
      }
    } catch (e) {
      console.error('Failed to fetch HIP-3 markets:', e);
    }
  }

  // Fetch spot markets
  if (args.type === 'all' || args.type === 'spot') {
    try {
      const spotData = await client.getSpotMetaAndAssetCtxs();
      // contexts carry coin field that matches pair.name; not necessarily aligned by index
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

        allMarkets.push({
          type: 'spot',
          provider: 'Spot',
          coin: pair.name,
          assetId: 10000 + pair.index,
          price: ctx.markPx,
          volume24h: parseFloat(ctx.dayNtlVlm || '0'),
        });
      }
    } catch (e) {
      console.error('Failed to fetch spot markets:', e);
    }
  }

  // Sort by volume
  allMarkets.sort((a, b) => b.volume24h - a.volume24h);

  // Apply top filter
  const markets = args.top ? allMarkets.slice(0, args.top) : allMarkets;

  if (args.json) {
    console.log(JSON.stringify(markets, null, 2));
    return;
  }

  // Group by type for display
  const perps = markets.filter((m) => m.type === 'perp');
  const hip3 = markets.filter((m) => m.type === 'hip3');
  const spots = markets.filter((m) => m.type === 'spot');

  // Print summary
  console.log('=== Market Summary ===\n');
  console.log(`Total Markets: ${allMarkets.length}`);
  console.log(`  - Main Perps: ${perps.length}`);
  console.log(`  - HIP-3 Perps: ${hip3.length}`);
  console.log(`  - Spot Markets: ${spots.length}`);
  console.log();

  // Print perps
  if (perps.length > 0) {
    console.log('=== Main Perpetuals ===\n');
    console.log('Coin           AssetID    Price            24h Volume    Funding (Ann.)  Leverage');
    console.log('-'.repeat(87));
    for (const m of perps) {
      console.log(
        `${m.coin.padEnd(14)} ${String(m.assetId).padStart(7)}    ${formatPrice(m.price).padStart(16)} ${formatVolume(m.volume24h).padStart(13)} ${(m.funding ? formatFunding(m.funding) : '-').padStart(14)} ${(m.maxLeverage ? `${m.maxLeverage}x` : '-').padStart(9)}`
      );
    }
    console.log();
  }

  // Print HIP-3 markets
  if (hip3.length > 0) {
    console.log('=== HIP-3 Perpetuals ===\n');
    console.log('Coin           Provider         AssetID    Price            24h Volume    Funding (Ann.)');
    console.log('-'.repeat(92));
    for (const m of hip3) {
      console.log(
        `${m.coin.padEnd(14)} ${m.provider.padEnd(16)} ${String(m.assetId).padStart(7)}    ${formatPrice(m.price).padStart(16)} ${formatVolume(m.volume24h).padStart(13)} ${(m.funding ? formatFunding(m.funding) : '-').padStart(14)}`
      );
    }
    console.log();
  }

  // Print spot markets
  if (spots.length > 0) {
    console.log('=== Spot Markets ===\n');
    console.log('Pair           AssetID    Price            24h Volume');
    console.log('-'.repeat(62));
    for (const m of spots) {
      console.log(
        `${m.coin.padEnd(14)} ${String(m.assetId).padStart(7)}    ${formatPrice(m.price).padStart(16)} ${formatVolume(m.volume24h).padStart(13)}`
      );
    }
    console.log();
  }
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
