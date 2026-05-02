#!/usr/bin/env tsx
// HIP-4 Outcomes - search and inspect prediction markets

import { getClient } from '../core/client.js';

interface Args {
  query?: string;
  outcome?: string;
  side?: string;
  balances?: boolean;
  top?: number;
  verbose?: boolean;
  json?: boolean;
}

function parseArgs(): Args {
  const args: Args = {};

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if ((arg === '--query' || arg === '-q') && process.argv[i + 1]) {
      args.query = process.argv[++i];
    } else if ((arg === '--outcome' || arg === '--id') && process.argv[i + 1]) {
      args.outcome = process.argv[++i];
    } else if (arg === '--side' && process.argv[i + 1]) {
      args.side = process.argv[++i];
    } else if (arg === '--balances') {
      args.balances = true;
    } else if (arg === '--top' && process.argv[i + 1]) {
      args.top = parseInt(process.argv[++i], 10);
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!args.query && !arg.startsWith('-')) {
      args.query = arg;
    }
  }

  return args;
}

function printUsage() {
  console.log(`
Open Broker - HIP-4 Outcomes
============================

Search and inspect Hyperliquid outcome markets.

Usage:
  openbroker outcomes [--query <text>] [--outcome <id|#encoding|+encoding>] [options]

Options:
  --query, -q <text>       Search market name, description, underlying, expiry, target
  --outcome, --id <ref>    Show one outcome by id or encoded coin (#1230 / +1230)
  --side <yes|no|0|1>      Select a side when using a plain outcome id
  --balances               Show outcome token balances for the configured account
  --top <n>                Show only top N matches
  --json                   Output as JSON
  --verbose                Include raw descriptions and question metadata

Examples:
  openbroker outcomes --query BTC
  openbroker outcomes --outcome 123
  openbroker outcomes --outcome 123 --side yes --json
  openbroker outcomes --balances
`);
}

function formatPrice(value?: string): string {
  if (!value) return '-';
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return value;
  return n.toFixed(4);
}

function formatVolume(value?: string): string {
  if (!value) return '-';
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return value;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

async function main() {
  const args = parseArgs();
  const client = getClient();
  client.verbose = args.verbose ?? false;

  if (!args.json) {
    console.log('Open Broker - HIP-4 Outcomes');
    console.log('============================\n');
  }

  try {
    if (args.balances) {
      const balances = await client.getSpotBalances();
      const outcomeBalances = (balances.balances ?? []).filter((b) =>
        b.coin.startsWith('+') || b.coin.startsWith('#')
      );

      if (args.json) {
        console.log(JSON.stringify(outcomeBalances, null, 2));
        return;
      }

      if (outcomeBalances.length === 0) {
        console.log('No outcome token balances found.');
        return;
      }

      console.log('Outcome Balances');
      console.log('----------------');
      console.log('Token        Total              Hold               Entry Value');
      console.log('-'.repeat(70));
      for (const b of outcomeBalances) {
        console.log(
          `${b.coin.padEnd(12)} ${parseFloat(b.total).toFixed(6).padStart(18)} ` +
          `${parseFloat(b.hold).toFixed(6).padStart(18)} ${formatVolume(b.entryNtl).padStart(15)}`
        );
      }
      return;
    }

    let markets = await client.getOutcomeMarkets();

    if (args.outcome) {
      const resolved = client.resolveOutcomeRef(args.outcome, args.side);
      markets = markets.filter((market) => market.outcome === resolved.outcome);
      for (const market of markets) {
        market.sides = market.sides.filter((side) => side.side === resolved.side);
      }
    }

    if (args.query) {
      const query = args.query.toUpperCase();
      markets = markets.filter((market) => {
        const parsed = Object.values(market.parsedDescription).join(' ');
        const searchable = `${market.name} ${market.description} ${parsed}`.toUpperCase();
        return searchable.includes(query);
      });
    }

    markets.sort((a, b) => {
      const aVol = Math.max(...a.sides.map((s) => parseFloat(s.dayNtlVlm ?? '0')));
      const bVol = Math.max(...b.sides.map((s) => parseFloat(s.dayNtlVlm ?? '0')));
      return bVol - aVol;
    });

    const displayMarkets = args.top ? markets.slice(0, args.top) : markets;

    if (args.json) {
      console.log(JSON.stringify(displayMarkets, null, 2));
      return;
    }

    if (displayMarkets.length === 0) {
      console.log('No outcome markets found.');
      return;
    }

    console.log(`Found ${displayMarkets.length} outcome market(s)\n`);
    console.log('Outcome   Side  Coin       AssetID      Price    24h Volume   Market');
    console.log('-'.repeat(98));

    for (const market of displayMarkets) {
      const spec = market.parsedDescription;
      const labelParts = [
        spec.underlying,
        spec.expiry ? `exp ${spec.expiry}` : undefined,
        spec.targetPrice ? `target ${spec.targetPrice}` : undefined,
      ].filter(Boolean);
      const label = labelParts.length > 0 ? labelParts.join(' | ') : market.description;

      for (const side of market.sides) {
        console.log(
          `${String(market.outcome).padStart(7)}   ${side.name.padEnd(4)}  ${side.coin.padEnd(9)} ` +
          `${String(side.assetId).padStart(10)}   ${formatPrice(side.midPx ?? side.markPx).padStart(7)} ` +
          `${formatVolume(side.dayNtlVlm).padStart(13)}   ${label}`
        );
      }

      if (args.verbose) {
        console.log(`          Description: ${market.description}`);
        if (market.question) console.log(`          Question: ${market.question.name}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    console.error('Note: Hyperliquid currently documents outcomeMeta as testnet-only.');
    process.exit(1);
  }
}

main();
