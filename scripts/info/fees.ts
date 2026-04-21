#!/usr/bin/env npx tsx
// View fee schedule and trading volume from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, formatPercent, parseArgs } from '../core/utils.js';

function printUsage() {
  console.log(`
Usage: openbroker fees [options]

Options:
  --address <0x...>  Look up another account's fees
  --json             Output as JSON (machine-readable)
  --help, -h         Show this help

Examples:
  openbroker fees
  openbroker fees --json
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printUsage();
    process.exit(0);
  }

  const targetAddress = args.address as string | undefined;
  const jsonOutput = args.json as boolean;
  const client = getClient();
  const lookupAddress = targetAddress?.toLowerCase();

  if (!jsonOutput) {
    console.log('Open Broker - Fee Schedule');
    console.log('=========================\n');

    if (targetAddress) {
      console.log(`Lookup: ${lookupAddress}\n`);
    }
  }

  try {
    const fees = await client.getUserFees(lookupAddress);

    if (jsonOutput) {
      console.log(JSON.stringify(fees, null, 2));
      return;
    }

    // Fee rates
    console.log('Fee Rates');
    console.log('─'.repeat(40));
    console.log(`Perp Taker (Cross):  ${formatPercent(parseFloat(fees.userCrossRate))}`);
    console.log(`Perp Maker (Add):    ${formatPercent(parseFloat(fees.userAddRate))}`);
    console.log(`Spot Taker (Cross):  ${formatPercent(parseFloat(fees.userSpotCrossRate))}`);
    console.log(`Spot Maker (Add):    ${formatPercent(parseFloat(fees.userSpotAddRate))}`);
    console.log('');

    // Discounts
    const refDiscount = parseFloat(fees.activeReferralDiscount);
    if (refDiscount > 0) {
      console.log(`Referral Discount:   ${formatPercent(refDiscount)}`);
    }
    if (fees.activeStakingDiscount) {
      console.log(`Staking Discount:    ${fees.activeStakingDiscount.basisPoints} bps (${formatPercent(parseFloat(fees.activeStakingDiscount.discountRate))})`);
    }
    if (fees.stakingLink) {
      console.log(`Staking Link:        ${fees.stakingLink.stakingUser} (${fees.stakingLink.status})`);
    }

    // Daily volumes
    if (fees.dailyUserVlm && fees.dailyUserVlm.length > 0) {
      console.log('\nRecent Daily Volume');
      console.log('─'.repeat(60));
      console.log(
        'Date'.padEnd(14) +
        'Cross Vol'.padEnd(18) +
        'Add Vol'.padEnd(18) +
        'Total'
      );
      console.log('─'.repeat(60));

      // Show last 7 days
      const recent = fees.dailyUserVlm.slice(-7);
      for (const day of recent) {
        const cross = parseFloat(day.userCross || '0');
        const add = parseFloat(day.userAdd || '0');
        console.log(
          day.date.padEnd(14) +
          formatUsd(cross).padEnd(18) +
          formatUsd(add).padEnd(18) +
          formatUsd(cross + add)
        );
      }
    }
  } catch (error) {
    console.error('Error fetching fees:', error);
    process.exit(1);
  }
}

main();
