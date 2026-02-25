#!/usr/bin/env npx tsx
// Check status of a specific order on Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker order-status --oid <order-id>

Options:
  --oid <id>    Order ID (number) or client order ID (hex string) — required
  --help, -h    Show this help

Examples:
  openbroker order-status --oid 123456789
  openbroker order-status --oid 0x1234abcd...
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const oidArg = args.oid as string | undefined;
  if (!oidArg) {
    console.error('Error: --oid is required');
    printUsage();
    process.exit(1);
  }

  const oid = oidArg.startsWith('0x') ? oidArg : parseInt(oidArg);
  const client = getClient();

  console.log('Open Broker - Order Status');
  console.log('=========================\n');

  try {
    const result = await client.getOrderStatus(oid);

    if (result.status === 'unknownOid') {
      console.log(`Order ${oidArg} not found`);
      return;
    }

    if (result.order) {
      const o = result.order.order;
      const time = new Date(o.timestamp).toLocaleString();
      const statusTime = new Date(result.order.statusTimestamp).toLocaleString();
      const side = o.side === 'B' ? 'BUY' : 'SELL';

      console.log(`${o.coin} - ${o.orderType}`);
      console.log('─'.repeat(40));
      console.log(`Order ID:       ${o.oid}`);
      if (o.cloid) console.log(`Client OID:     ${o.cloid}`);
      console.log(`Side:           ${side}`);
      console.log(`Size:           ${o.sz} (orig: ${o.origSz})`);
      console.log(`Limit Price:    ${formatUsd(parseFloat(o.limitPx))}`);
      console.log(`Type:           ${o.orderType}`);
      if (o.tif) console.log(`Time in Force:  ${o.tif}`);
      console.log(`Reduce Only:    ${o.reduceOnly ? 'Yes' : 'No'}`);
      if (o.isTrigger) {
        console.log(`Trigger Price:  ${formatUsd(parseFloat(o.triggerPx))}`);
        console.log(`Trigger Cond:   ${o.triggerCondition}`);
      }
      if (o.isPositionTpsl) console.log(`Position TP/SL: Yes`);
      console.log(`Status:         ${result.order.status}`);
      console.log(`Created:        ${time}`);
      console.log(`Status Updated: ${statusTime}`);
    }
  } catch (error) {
    console.error('Error fetching order status:', error);
    process.exit(1);
  }
}

main();
