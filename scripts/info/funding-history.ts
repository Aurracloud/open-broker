#!/usr/bin/env npx tsx
// View historical funding rates for an asset on Hyperliquid

import { getClient } from '../core/client.js';
import { formatPercent, annualizeFundingRate, parseArgs, normalizeCoin } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker funding-history --coin <symbol> [options]

Options:
  --coin <symbol>   Asset symbol (required, e.g. ETH, BTC)
  --hours <n>       Hours of history to fetch (default: 24)
  --help, -h        Show this help

Examples:
  openbroker funding-history --coin ETH
  openbroker funding-history --coin BTC --hours 168
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const coin = args.coin as string | undefined;
  if (!coin) {
    console.error('Error: --coin is required');
    printUsage();
    process.exit(1);
  }

  const hours = parseInt(args.hours as string) || 24;
  const client = getClient();

  console.log(`Open Broker - ${normalizeCoin(coin)} Funding History (${hours}h)`);
  console.log('='.repeat(40) + '\n');

  try {
    // Load metadata (needed for HIP-3 coin resolution)
    await client.getMetaAndAssetCtxs();
    if (client.isTestnet && coin.includes(':')) {
      await client.loadSingleHip3Dex(coin.split(':')[0]);
    }

    const now = Date.now();
    const startTime = now - (hours * 3_600_000);
    const history = await client.getFundingHistory(normalizeCoin(coin), startTime);

    if (history.length === 0) {
      console.log('No funding history found');
      return;
    }

    // Table header
    console.log(
      'Time'.padEnd(20) +
      'Funding Rate'.padEnd(16) +
      'Annualized'.padEnd(14) +
      'Premium'
    );
    console.log('─'.repeat(60));

    let totalRate = 0;

    for (const entry of history) {
      const time = new Date(entry.time).toLocaleString();
      const rate = parseFloat(entry.fundingRate);
      const annualized = annualizeFundingRate(rate);
      const premium = parseFloat(entry.premium);
      totalRate += rate;

      console.log(
        time.padEnd(20) +
        formatPercent(rate, 6).padEnd(16) +
        formatPercent(annualized).padEnd(14) +
        formatPercent(premium, 4)
      );
    }

    // Summary
    const avgRate = totalRate / history.length;
    const avgAnnualized = annualizeFundingRate(avgRate);

    console.log('─'.repeat(60));
    console.log(`Samples: ${history.length}`);
    console.log(`Avg Hourly Rate:  ${formatPercent(avgRate, 6)}`);
    console.log(`Avg Annualized:   ${formatPercent(avgAnnualized)}`);

    if (avgRate > 0) {
      console.log('Longs pay shorts');
    } else if (avgRate < 0) {
      console.log('Shorts pay longs');
    }
  } catch (error) {
    console.error('Error fetching funding history:', error);
    process.exit(1);
  }
}

main();
