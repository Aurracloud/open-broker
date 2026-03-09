#!/usr/bin/env npx tsx
// Cross-dex funding rate scanner - scan all assets (main + HIP-3) for funding opportunities

import { getClient } from '../core/client.js';
import { formatUsd, formatPercent, annualizeFundingRate, parseArgs, sleep } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker funding-scan [options]

Scan funding rates across all dexes (main perps + HIP-3) and find opportunities.

Options:
  --threshold <n>   Min annualized funding rate % to show (default: 25)
  --include-hip3    Include HIP-3 dex assets (default: true)
  --main-only       Only scan main perps
  --hip3-only       Only scan HIP-3 perps
  --top <n>         Show top N results (default: 30)
  --pairs           Show correlated pairs with opposing funding
  --json            Output as JSON
  --watch           Re-scan periodically
  --interval <n>    Watch interval in seconds (default: 60)
  --help, -h        Show this help

Examples:
  openbroker funding-scan
  openbroker funding-scan --threshold 50 --pairs
  openbroker funding-scan --hip3-only --top 20
  openbroker funding-scan --watch --interval 120
`);
}

interface FundingScanResult {
  coin: string;
  dex: string;
  hourlyRate: number;
  annualizedPct: number;
  direction: 'longs pay' | 'shorts pay';
  openInterest: number;
  markPx: number;
}

async function scanFunding(client: ReturnType<typeof getClient>, options: {
  threshold: number;
  mainOnly: boolean;
  hip3Only: boolean;
  topN: number;
}): Promise<FundingScanResult[]> {
  const allPerps = await client.getAllPerpMetas();
  const results: FundingScanResult[] = [];

  for (const dexData of allPerps) {
    const isMain = !dexData.dexName;
    if (options.mainOnly && !isMain) continue;
    if (options.hip3Only && isMain) continue;

    for (let i = 0; i < dexData.meta.universe.length; i++) {
      const asset = dexData.meta.universe[i];
      const ctx = dexData.assetCtxs[i];
      if (!ctx) continue;

      const hourlyRate = parseFloat(ctx.funding);
      const annualizedPct = annualizeFundingRate(hourlyRate) * 100;
      const openInterest = parseFloat(ctx.openInterest);
      const markPx = parseFloat(ctx.markPx);

      if (Math.abs(annualizedPct) < options.threshold) continue;
      if (openInterest < 100) continue;

      const coin = dexData.dexName ? `${dexData.dexName}:${asset.name}` : asset.name;

      results.push({
        coin,
        dex: dexData.dexName ?? 'main',
        hourlyRate,
        annualizedPct,
        direction: hourlyRate > 0 ? 'longs pay' : 'shorts pay',
        openInterest,
        markPx,
      });
    }
  }

  // Sort by absolute annualized rate
  results.sort((a, b) => Math.abs(b.annualizedPct) - Math.abs(a.annualizedPct));
  return results.slice(0, options.topN);
}

function printResults(results: FundingScanResult[], showPairs: boolean) {
  if (results.length === 0) {
    console.log('No assets above threshold');
    return;
  }

  // Table header
  console.log(
    'Coin'.padEnd(16) +
    'Dex'.padEnd(8) +
    'Annualized'.padEnd(14) +
    'Direction'.padEnd(14) +
    'OI'.padEnd(14) +
    'Mark'
  );
  console.log('─'.repeat(75));

  for (const r of results) {
    const annStr = `${r.annualizedPct >= 0 ? '+' : ''}${r.annualizedPct.toFixed(1)}%`;
    const oiStr = formatOI(r.openInterest);

    console.log(
      r.coin.padEnd(16) +
      r.dex.padEnd(8) +
      annStr.padStart(12).padEnd(14) +
      r.direction.padEnd(14) +
      oiStr.padStart(12).padEnd(14) +
      formatUsd(r.markPx)
    );
  }

  // Show opposing pairs
  if (showPairs) {
    console.log('\nOpposing Funding Pairs:');
    console.log('─'.repeat(75));

    const longs = results.filter(r => r.annualizedPct > 0); // longs pay shorts
    const shorts = results.filter(r => r.annualizedPct < 0); // shorts pay longs

    const pairs: Array<{ long: FundingScanResult; short: FundingScanResult; spread: number }> = [];

    for (const l of longs) {
      for (const s of shorts) {
        // Only pair across different dexes or correlated assets
        const spread = l.annualizedPct + Math.abs(s.annualizedPct);
        if (spread > 20) {
          pairs.push({ long: l, short: s, spread });
        }
      }
    }

    pairs.sort((a, b) => b.spread - a.spread);

    for (const p of pairs.slice(0, 10)) {
      console.log(
        `  SHORT ${p.long.coin.padEnd(14)} (${p.long.annualizedPct.toFixed(1)}%) ` +
        `+ LONG ${p.short.coin.padEnd(14)} (${p.short.annualizedPct.toFixed(1)}%) ` +
        `= ${p.spread.toFixed(1)}% spread`
      );
    }

    if (pairs.length === 0) {
      console.log('  No strong opposing pairs found');
    }
  }
}

function formatOI(oi: number): string {
  if (oi >= 1_000_000) return `$${(oi / 1_000_000).toFixed(2)}M`;
  if (oi >= 1_000) return `$${(oi / 1_000).toFixed(1)}K`;
  return `$${oi.toFixed(0)}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const threshold = args.threshold ? parseFloat(args.threshold as string) : 25;
  const mainOnly = args['main-only'] as boolean ?? false;
  const hip3Only = args['hip3-only'] as boolean ?? false;
  const topN = parseInt(args.top as string) || 30;
  const showPairs = args.pairs as boolean ?? false;
  const outputJson = args.json as boolean ?? false;
  const watch = args.watch as boolean ?? false;
  const intervalSec = args.interval ? parseInt(args.interval as string) : 60;

  const client = getClient();
  if (args.verbose) client.verbose = true;

  console.log('Open Broker - Funding Rate Scanner');
  console.log('==================================\n');
  console.log(`Threshold: ${threshold}% annualized | Scope: ${mainOnly ? 'main only' : hip3Only ? 'HIP-3 only' : 'all dexes'}\n`);

  const options = { threshold, mainOnly, hip3Only, topN };

  const runScan = async () => {
    const results = await scanFunding(client, options);

    if (outputJson) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      printResults(results, showPairs);
    }

    return results;
  };

  await runScan();

  if (watch) {
    console.log(`\nWatching every ${intervalSec}s... (Ctrl+C to stop)\n`);
    while (true) {
      await sleep(intervalSec * 1000);
      console.log(`\n[${new Date().toLocaleTimeString()}] Rescanning...\n`);
      await runScan();
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
