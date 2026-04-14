#!/usr/bin/env npx tsx
// View historical orders from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs, normalizeCoin } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker orders [options]

Options:
  --coin <symbol>     Filter by coin (e.g. ETH, BTC)
  --status <status>   Filter by status (filled, canceled, open, triggered, rejected, etc.)
  --open              Show only currently open orders
  --top <n>           Show last N orders (default: 20)
  --address <0x...>   Look up another account's orders
  --help, -h          Show this help

Examples:
  openbroker orders
  openbroker orders --open
  openbroker orders --open --coin ETH
  openbroker orders --coin ETH --status filled
  openbroker orders --top 50
  openbroker orders --address 0xabc... --open
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const filterCoin = args.coin as string | undefined;
  const filterStatus = args.status as string | undefined;
  const openOnly = args.open as boolean;
  const top = parseInt(args.top as string) || 20;
  const jsonOutput = args.json as boolean;
  const targetAddress = args.address as string | undefined;
  const client = getClient();

  const lookupAddress = targetAddress?.toLowerCase();

  try {
    // On testnet, load specific HIP-3 dex on demand if filtering by dex:COIN
    if (client.isTestnet && filterCoin?.includes(':')) {
      await client.loadSingleHip3Dex(filterCoin.split(':')[0]);
    }

    if (openOnly) {
      // Use the dedicated open orders endpoint
      let openOrders = await client.getOpenOrders(lookupAddress);

      if (filterCoin) {
        openOrders = openOrders.filter(o => o.coin === normalizeCoin(filterCoin));
      }

      openOrders.sort((a, b) => b.timestamp - a.timestamp);
      openOrders = openOrders.slice(0, top);

      if (jsonOutput) {
        console.log(JSON.stringify(openOrders.map(o => ({
          time: new Date(o.timestamp).toISOString(),
          coin: o.coin,
          side: o.side === 'B' ? 'buy' : 'sell',
          orderType: o.orderType,
          size: o.sz,
          origSize: o.origSz,
          price: o.limitPx,
          status: 'open',
          oid: o.oid,
        })), null, 2));
        return;
      }

      console.log('Open Broker - Open Orders');
      console.log('=========================\n');

      if (targetAddress) {
        console.log(`Lookup: ${lookupAddress}\n`);
      }

      if (openOrders.length === 0) {
        console.log('No open orders found');
        return;
      }

      // Table header
      console.log(
        'Time'.padEnd(20) +
        'Coin'.padEnd(10) +
        'Side'.padEnd(6) +
        'Type'.padEnd(14) +
        'Size'.padEnd(12) +
        'Price'.padEnd(14) +
        'OID'
      );
      console.log('─'.repeat(90));

      for (const o of openOrders) {
        const time = new Date(o.timestamp).toLocaleString();
        const side = o.side === 'B' ? 'BUY' : 'SELL';

        console.log(
          time.padEnd(20) +
          o.coin.padEnd(10) +
          side.padEnd(6) +
          o.orderType.padEnd(14) +
          o.sz.padEnd(12) +
          formatUsd(parseFloat(o.limitPx)).padEnd(14) +
          String(o.oid)
        );
      }

      console.log('─'.repeat(90));
      console.log(`Showing ${openOrders.length} open orders`);
      return;
    }

    let orders = await client.getHistoricalOrders(lookupAddress);

    if (filterCoin) {
      orders = orders.filter(o => o.order.coin === normalizeCoin(filterCoin));
    }
    if (filterStatus) {
      const s = filterStatus.toLowerCase();
      orders = orders.filter(o => o.status.toLowerCase().includes(s));
    }

    // Most recent first
    orders.sort((a, b) => b.order.timestamp - a.order.timestamp);
    orders = orders.slice(0, top);

    if (jsonOutput) {
      console.log(JSON.stringify(orders.map(entry => ({
        time: new Date(entry.order.timestamp).toISOString(),
        coin: entry.order.coin,
        side: entry.order.side === 'B' ? 'buy' : 'sell',
        orderType: entry.order.orderType,
        size: entry.order.sz,
        price: entry.order.limitPx,
        status: entry.status,
        oid: entry.order.oid,
      })), null, 2));
      return;
    }

    console.log('Open Broker - Order History');
    console.log('==========================\n');

    if (targetAddress) {
      console.log(`Lookup: ${lookupAddress}\n`);
    }

    if (orders.length === 0) {
      console.log('No orders found');
      return;
    }

    // Table header
    console.log(
      'Time'.padEnd(20) +
      'Coin'.padEnd(10) +
      'Side'.padEnd(6) +
      'Type'.padEnd(14) +
      'Size'.padEnd(12) +
      'Price'.padEnd(14) +
      'Status'
    );
    console.log('─'.repeat(90));

    for (const entry of orders) {
      const o = entry.order;
      const time = new Date(o.timestamp).toLocaleString();
      const side = o.side === 'B' ? 'BUY' : 'SELL';

      console.log(
        time.padEnd(20) +
        o.coin.padEnd(10) +
        side.padEnd(6) +
        o.orderType.padEnd(14) +
        o.sz.padEnd(12) +
        formatUsd(parseFloat(o.limitPx)).padEnd(14) +
        entry.status
      );
    }

    console.log('─'.repeat(90));
    console.log(`Showing ${orders.length} orders`);
  } catch (error) {
    console.error('Error fetching orders:', error);
    process.exit(1);
  }
}

main();
