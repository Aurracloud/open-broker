#!/usr/bin/env npx tsx
// View OHLCV candle data from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

const VALID_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '8h', '12h', '1d', '3d', '1w', '1M'];

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '8h': 28_800_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000, '1M': 2_592_000_000,
};

function printUsage() {
  console.log(`
Usage: openbroker candles --coin <symbol> [options]

Options:
  --coin <symbol>      Asset symbol (required, e.g. ETH, BTC)
  --interval <interval> Candle interval (default: 1h)
                       Valid: ${VALID_INTERVALS.join(', ')}
  --bars <n>           Number of bars to fetch (default: 24)
  --help, -h           Show this help

Examples:
  openbroker candles --coin ETH
  openbroker candles --coin BTC --interval 4h --bars 48
  openbroker candles --coin SOL --interval 1d --bars 30
`);
}

function formatVolume(v: number): string {
  if (v >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return formatUsd(v);
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

  const interval = (args.interval as string) || '1h';
  if (!VALID_INTERVALS.includes(interval)) {
    console.error(`Error: invalid interval "${interval}". Valid: ${VALID_INTERVALS.join(', ')}`);
    process.exit(1);
  }

  const bars = parseInt(args.bars as string) || 24;
  const client = getClient();

  console.log(`Open Broker - ${coin.toUpperCase()} Candles (${interval})`);
  console.log('='.repeat(40) + '\n');

  try {
    // Load metadata (needed for HIP-3 coin resolution)
    await client.getMetaAndAssetCtxs();

    const now = Date.now();
    const startTime = now - (bars * (INTERVAL_MS[interval] || 3_600_000));
    const candles = await client.getCandleSnapshot(coin.toUpperCase(), interval, startTime);

    if (candles.length === 0) {
      console.log('No candle data found');
      return;
    }

    // Table header
    console.log(
      'Time'.padEnd(20) +
      'Open'.padEnd(14) +
      'High'.padEnd(14) +
      'Low'.padEnd(14) +
      'Close'.padEnd(14) +
      'Volume'.padEnd(12) +
      'Trades'
    );
    console.log('─'.repeat(95));

    for (const c of candles) {
      const time = new Date(c.t).toLocaleString();
      const vol = parseFloat(c.v);

      console.log(
        time.padEnd(20) +
        formatUsd(parseFloat(c.o)).padEnd(14) +
        formatUsd(parseFloat(c.h)).padEnd(14) +
        formatUsd(parseFloat(c.l)).padEnd(14) +
        formatUsd(parseFloat(c.c)).padEnd(14) +
        formatVolume(vol).padEnd(12) +
        String(c.n)
      );
    }

    // Summary
    const opens = candles.map(c => parseFloat(c.o));
    const highs = candles.map(c => parseFloat(c.h));
    const lows = candles.map(c => parseFloat(c.l));
    const closes = candles.map(c => parseFloat(c.c));
    const totalVol = candles.reduce((s, c) => s + parseFloat(c.v), 0);
    const totalTrades = candles.reduce((s, c) => s + c.n, 0);

    console.log('─'.repeat(95));
    console.log(`Bars: ${candles.length}  |  High: ${formatUsd(Math.max(...highs))}  |  Low: ${formatUsd(Math.min(...lows))}  |  Volume: ${formatVolume(totalVol)}  |  Trades: ${totalTrades}`);
    console.log(`Change: ${formatUsd(closes[closes.length - 1] - opens[0])} (${((closes[closes.length - 1] - opens[0]) / opens[0] * 100).toFixed(2)}%)`);
  } catch (error) {
    console.error('Error fetching candles:', error);
    process.exit(1);
  }
}

main();
