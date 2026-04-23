#!/usr/bin/env npx tsx
// Cancel a running TWAP order

import { getClient } from '../core/client.js';
import { parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Open Broker - Cancel TWAP Order
================================

Cancel a running native Hyperliquid TWAP order.

Usage:
  npx tsx scripts/operations/twap-cancel.ts --coin <COIN> --twap-id <ID>

Options:
  --coin        Asset symbol (e.g., ETH, BTC)
  --twap-id     TWAP order ID to cancel
  --verbose     Show debug output

Examples:
  npx tsx scripts/operations/twap-cancel.ts --coin ETH --twap-id 77738308
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const coin = args.coin as string;
  const twapId = args['twap-id'] ? parseInt(args['twap-id'] as string) : NaN;

  if (!coin || isNaN(twapId)) {
    printUsage();
    process.exit(1);
  }

  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  console.log('Open Broker - Cancel TWAP Order');
  console.log('===============================\n');

  try {
    console.log(`Cancelling TWAP ${twapId} for ${coin}...`);

    const response = await client.twapCancel(coin, twapId);

    // SDK returns a success-only response shape; failures throw and are
    // caught by the surrounding try/catch. `status` is the success literal.
    const status = response.response.data.status;
    if (typeof status === 'string' && status === 'success') {
      console.log(`\nTWAP order ${twapId} cancelled successfully.`);
    } else {
      console.error(`\nUnexpected TWAP cancel response status: ${JSON.stringify(status)}`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
