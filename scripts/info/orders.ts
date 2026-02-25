#!/usr/bin/env npx tsx
// View historical orders from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker orders [options]

Options:
  --coin <symbol>     Filter by coin (e.g. ETH, BTC)
  --status <status>   Filter by status (filled, canceled, open, triggered, rejected, etc.)
  --top <n>           Show last N orders (default: 20)
  --help, -h          Show this help

Examples:
  openbroker orders
  openbroker orders --coin ETH --status filled
  openbroker orders --top 50
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
  const top = parseInt(args.top as string) || 20;
  const client = getClient();

  console.log('Open Broker - Order History');
  console.log('==========================\n');

  try {
    let orders = await client.getHistoricalOrders();

    if (filterCoin) {
      orders = orders.filter(o => o.order.coin === filterCoin.toUpperCase());
    }
    if (filterStatus) {
      const s = filterStatus.toLowerCase();
      orders = orders.filter(o => o.status.toLowerCase().includes(s));
    }

    // Most recent first
    orders.sort((a, b) => b.order.timestamp - a.order.timestamp);
    orders = orders.slice(0, top);

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
