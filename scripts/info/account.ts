#!/usr/bin/env npx tsx
// Get account info from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, formatPercent, parseArgs } from '../core/utils.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const jsonOutput = args.json as boolean;
  const targetAddress = args.address as string | undefined;
  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  const lookupAddress = targetAddress?.toLowerCase() ?? client.address;
  const isOtherAccount = !!targetAddress;

  const accountMode = await client.getAccountMode(isOtherAccount ? lookupAddress : undefined);

  try {
    const state = await client.getUserStateAll(isOtherAccount ? lookupAddress : undefined);

    const margin = state.crossMarginSummary;
    const accountValue = parseFloat(margin.accountValue);
    const totalMarginUsed = parseFloat(margin.totalMarginUsed);
    const withdrawable = parseFloat(margin.withdrawable);
    const totalNotional = parseFloat(margin.totalNtlPos);

    const positions = state.assetPositions
      .filter(ap => Math.abs(parseFloat(ap.position.szi)) >= 0.0001)
      .map(ap => {
        const pos = ap.position;
        const size = parseFloat(pos.szi);
        const entryPx = parseFloat(pos.entryPx);
        const notional = parseFloat(pos.positionValue);
        const markPx = Math.abs(notional / size);
        const pnl = parseFloat(pos.unrealizedPnl);
        return {
          coin: pos.coin,
          side: size > 0 ? 'long' : 'short',
          size: pos.szi,
          entryPrice: pos.entryPx,
          markPrice: markPx,
          notional: Math.abs(notional),
          unrealizedPnl: pnl,
          leverage: `${pos.leverage.value}x ${pos.leverage.type}`,
          liquidationPx: pos.liquidationPx,
        };
      });

    const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

    // Fetch spot balances
    const userParam = isOtherAccount ? lookupAddress : undefined;
    const spotState = await client.getSpotBalances(userParam);
    const spotBalances = (spotState?.balances ?? []).filter(b => parseFloat(b.total) > 0);

    // JSON output
    if (jsonOutput) {
      const result: Record<string, unknown> = {
        address: lookupAddress,
        ...(isOtherAccount ? {} : {
          signingWallet: client.walletAddress,
          walletType: client.isApiWallet ? 'api' : 'main',
        }),
        accountMode,
        equity: accountValue,
        totalNotional,
        totalMarginUsed,
        withdrawable,
        marginRatio: totalMarginUsed > 0 && accountValue > 0 ? totalMarginUsed / accountValue : 0,
        totalUnrealizedPnl: totalPnl,
        positions,
        spotBalances: spotBalances.map(b => ({
          coin: b.coin,
          total: b.total,
          hold: b.hold,
          entryNtl: b.entryNtl,
        })),
      };

      if (args.orders) {
        const orders = await client.getOpenOrders(isOtherAccount ? lookupAddress : undefined);
        result.openOrders = orders.map(o => ({
          coin: o.coin,
          oid: o.oid,
          side: o.side === 'B' ? 'buy' : 'sell',
          size: o.sz,
          price: o.limitPx,
          orderType: o.orderType,
          timestamp: o.timestamp,
        }));
      }

      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable output
    console.log('Open Broker - Account Info');
    console.log('==========================\n');

    if (isOtherAccount) {
      console.log('Lookup Address');
      console.log('--------------------');
      console.log(`Address:          ${lookupAddress}`);
    } else {
      console.log('Wallet Configuration');
      console.log('--------------------');
      console.log(`Trading Account:  ${client.address}`);
      console.log(`Signing Wallet:   ${client.walletAddress}`);
      console.log(`Wallet Type:      ${client.isApiWallet ? 'API Wallet' : 'Main Wallet'}`);
    }

    const modeLabel: Record<string, string> = {
      standard: 'Standard (separate balances per dex)',
      unified: 'Unified Account (shared USDC across all dexes)',
      portfolio: 'Portfolio Margin',
      dexAbstraction: 'DEX Abstraction (deprecated)',
    };
    console.log(`Account Mode:     ${modeLabel[accountMode] ?? accountMode}`);

    if (!isOtherAccount) {
      // Check builder fee approval
      const builderApproval = await client.getMaxBuilderFee();
      console.log(`Builder Address:  ${client.builderAddress}`);
      console.log(`Builder Fee:      ${client.builderFeeBps} bps`);
      if (builderApproval) {
        console.log(`Builder Approved: ✅ Yes (max: ${builderApproval})`);
      } else {
        console.log(`Builder Approved: ❌ No`);
        console.log(`\n⚠️  Run: npx tsx scripts/setup/approve-builder.ts`);
      }

      // Warn if API wallet setup looks misconfigured
      if (!client.isApiWallet && accountValue === 0 && positions.length === 0) {
        console.log('\n⚠️  No positions and $0 equity.');
        console.log('   If this account is traded via an API wallet, set HYPERLIQUID_ACCOUNT_ADDRESS');
        console.log('   in ~/.openbroker/.env to the master account address (the wallet that holds funds).');
      }
    }
    console.log('');

    console.log('Margin Summary');
    console.log('--------------');
    console.log(`Account Value:    ${formatUsd(accountValue)}`);
    console.log(`Total Notional:   ${formatUsd(totalNotional)}`);
    console.log(`Margin Used:      ${formatUsd(totalMarginUsed)}`);
    console.log(`Withdrawable:     ${formatUsd(withdrawable)}`);

    if (totalMarginUsed > 0) {
      const marginRatio = totalMarginUsed / accountValue;
      console.log(`Margin Ratio:     ${formatPercent(marginRatio)}`);
    }

    console.log('\nPositions Summary');
    console.log('-----------------');

    if (positions.length === 0) {
      console.log('No open positions');
    } else {
      console.log('Coin     | Size       | Entry      | Mark       | PnL        | Leverage');
      console.log('---------|------------|------------|------------|------------|----------');

      for (const p of positions) {
        const side = p.side === 'long' ? 'L' : 'S';
        console.log(
          `${p.coin.padEnd(8)} | ${side} ${Math.abs(parseFloat(p.size)).toFixed(4).padStart(8)} | ` +
          `${formatUsd(parseFloat(p.entryPrice)).padStart(10)} | ${formatUsd(p.markPrice).padStart(10)} | ` +
          `${formatUsd(p.unrealizedPnl).padStart(10)} | ${p.leverage}`
        );
      }

      console.log('---------|------------|------------|------------|------------|----------');
      console.log(`Total Unrealized PnL: ${formatUsd(totalPnl)}`);
    }

    // Show spot balances
    if (spotBalances.length > 0) {
      console.log('\nSpot Balances');
      console.log('-------------');
      console.log('Token        | Total              | Hold               | Entry Value');
      console.log('-------------|--------------------|--------------------|------------');

      for (const b of spotBalances) {
        const total = parseFloat(b.total);
        const hold = parseFloat(b.hold);
        const entry = parseFloat(b.entryNtl);
        console.log(
          `${b.coin.padEnd(12)} | ${total.toFixed(6).padStart(18)} | ${hold.toFixed(6).padStart(18)} | ${formatUsd(entry)}`
        );
      }
    }

    // Show open orders if requested
    if (args.orders) {
      console.log('\nOpen Orders');
      console.log('-----------');

      const orders = await client.getOpenOrders(isOtherAccount ? lookupAddress : undefined);
      if (orders.length === 0) {
        console.log('No open orders');
      } else {
        console.log('Coin     | Side | Size       | Price      | Type');
        console.log('---------|------|------------|------------|------');
        for (const order of orders) {
          const side = order.side === 'B' ? 'BUY ' : 'SELL';
          console.log(
            `${order.coin.padEnd(8)} | ${side} | ${parseFloat(order.sz).toFixed(4).padStart(10)} | ` +
            `${formatUsd(parseFloat(order.limitPx)).padStart(10)} | ${order.orderType}`
          );
        }
      }
    }

  } catch (error) {
    console.error('Error fetching account info:', error);
    process.exit(1);
  }
}

main();
