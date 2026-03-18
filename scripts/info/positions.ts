#!/usr/bin/env npx tsx
// Get detailed position info from Hyperliquid

import { getClient } from '../core/client.js';
import { formatUsd, formatPercent, parseArgs } from '../core/utils.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filterCoin = args.coin as string | undefined;
  const jsonOutput = args.json as boolean;
  const client = getClient();

  if (args.verbose) {
    client.verbose = true;
  }

  try {
    const [state, mids, fundingHistory] = await Promise.all([
      client.getUserStateAll(),
      client.getAllMids(),
      client.getUserFunding(),
    ]);

    const positions = state.assetPositions.filter(ap => {
      const size = parseFloat(ap.position.szi);
      if (Math.abs(size) < 0.0001) return false;
      if (filterCoin && ap.position.coin !== filterCoin) return false;
      return true;
    });

    // Sum cumulative funding per coin
    const fundingByCoin = new Map<string, number>();
    for (const entry of fundingHistory) {
      const coin = entry.delta.coin;
      const usdc = parseFloat(entry.delta.usdc);
      fundingByCoin.set(coin, (fundingByCoin.get(coin) ?? 0) + usdc);
    }

    // JSON output
    if (jsonOutput) {
      const result = positions.map(ap => {
        const pos = ap.position;
        const size = parseFloat(pos.szi);
        const markPx = parseFloat(mids[pos.coin] || '0');
        const liqPx = pos.liquidationPx ? parseFloat(pos.liquidationPx) : null;
        return {
          coin: pos.coin,
          side: size > 0 ? 'long' : 'short',
          size: pos.szi,
          entryPrice: pos.entryPx,
          markPrice: markPx,
          notional: Math.abs(parseFloat(pos.positionValue)),
          unrealizedPnl: parseFloat(pos.unrealizedPnl),
          returnOnEquity: parseFloat(pos.returnOnEquity),
          cumulativeFunding: fundingByCoin.get(pos.coin) ?? 0,
          marginUsed: parseFloat(pos.marginUsed),
          leverage: `${pos.leverage.value}x`,
          leverageType: pos.leverage.type,
          liquidationPrice: liqPx,
          liquidationDistance: liqPx && markPx ? Math.abs((markPx - liqPx) / markPx) : null,
          maxLeverage: pos.maxLeverage,
        };
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    // Human-readable output
    console.log('Open Broker - Positions');
    console.log('=======================\n');

    if (positions.length === 0) {
      console.log(filterCoin ? `No position in ${filterCoin}` : 'No open positions');
      if (!filterCoin && !client.isApiWallet) {
        console.log('\n⚠️  If this account is traded via an API wallet, set HYPERLIQUID_ACCOUNT_ADDRESS');
        console.log('   in ~/.openbroker/.env to the master account address.');
      }
      return;
    }

    for (const ap of positions) {
      const pos = ap.position;
      const size = parseFloat(pos.szi);
      const entryPx = parseFloat(pos.entryPx);
      const notional = parseFloat(pos.positionValue);
      const pnl = parseFloat(pos.unrealizedPnl);
      const marginUsed = parseFloat(pos.marginUsed);
      const roe = parseFloat(pos.returnOnEquity);

      const markPx = parseFloat(mids[pos.coin] || '0');
      const side = size > 0 ? 'LONG' : 'SHORT';
      const sideEmoji = size > 0 ? '+' : '-';
      const cumulativeFunding = fundingByCoin.get(pos.coin) ?? 0;

      console.log(`${pos.coin} - ${side}`);
      console.log('─'.repeat(40));
      console.log(`Size:           ${sideEmoji}${Math.abs(size).toFixed(6)}`);
      console.log(`Entry Price:    ${formatUsd(entryPx)}`);
      console.log(`Mark Price:     ${formatUsd(markPx)}`);
      console.log(`Notional:       ${formatUsd(Math.abs(notional))}`);
      console.log(`Unrealized PnL: ${formatUsd(pnl)} (${formatPercent(roe)})`);
      console.log(`Cum. Funding:   ${formatUsd(cumulativeFunding)}${cumulativeFunding >= 0 ? ' (received)' : ' (paid)'}`);
      console.log(`Margin Used:    ${formatUsd(marginUsed)}`);
      console.log(`Leverage:       ${pos.leverage.value}x (${pos.leverage.type})`);

      if (pos.liquidationPx) {
        const liqPx = parseFloat(pos.liquidationPx);
        const liqDistance = Math.abs((markPx - liqPx) / markPx);
        console.log(`Liquidation:    ${formatUsd(liqPx)} (${formatPercent(liqDistance)} away)`);
      }

      console.log(`Max Leverage:   ${pos.maxLeverage}x`);
      console.log('');
    }

    // Summary
    const totalFunding = Array.from(fundingByCoin.values()).reduce((sum, v) => sum + v, 0);
    if (positions.length > 1) {
      const totalPnl = positions.reduce(
        (sum, ap) => sum + parseFloat(ap.position.unrealizedPnl),
        0
      );
      const totalNotional = positions.reduce(
        (sum, ap) => sum + Math.abs(parseFloat(ap.position.positionValue)),
        0
      );

      console.log('Summary');
      console.log('─'.repeat(40));
      console.log(`Total Positions: ${positions.length}`);
      console.log(`Total Notional:  ${formatUsd(totalNotional)}`);
      console.log(`Total PnL:       ${formatUsd(totalPnl)}`);
      console.log(`Total Funding:   ${formatUsd(totalFunding)}${totalFunding >= 0 ? ' (received)' : ' (paid)'}`);
    }

  } catch (error) {
    console.error('Error fetching positions:', error);
    process.exit(1);
  }
}

main();
