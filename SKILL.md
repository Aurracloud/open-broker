---
name: open-broker
description: Hyperliquid trading toolkit. Execute market orders, limit orders, check positions, view funding rates, and analyze markets. Use for any Hyperliquid perp trading task.
license: MIT
compatibility: Requires Node.js 22+, network access to api.hyperliquid.xyz
metadata:
  author: monemetrics
  version: "1.0.0"
allowed-tools: Bash(npx:*) Bash(tsx:*) Read
---

# Open Broker - Hyperliquid Trading Skill

Execute trading operations on Hyperliquid DEX with builder fee support.

## Setup

1. Navigate to the open-broker directory
2. Install dependencies: `npm install`
3. Set environment variable:
   ```bash
   export HYPERLIQUID_PRIVATE_KEY="0x..."
   ```

4. For testnet, also set:
   ```bash
   export HYPERLIQUID_NETWORK="testnet"
   ```

## Quick Reference

### Get Account Info
```bash
npx tsx scripts/info/account.ts
npx tsx scripts/info/account.ts --orders  # include open orders
```

### Get Positions
```bash
npx tsx scripts/info/positions.ts
npx tsx scripts/info/positions.ts --coin ETH
```

### Check Funding Rates
```bash
npx tsx scripts/info/funding.ts --top 20
npx tsx scripts/info/funding.ts --coin ETH
```

### View Markets
```bash
npx tsx scripts/info/markets.ts --top 30
npx tsx scripts/info/markets.ts --coin BTC
```

### Market Order
```bash
npx tsx scripts/operations/market-order.ts --coin ETH --side buy --size 0.1
npx tsx scripts/operations/market-order.ts --coin BTC --side sell --size 0.01 --slippage 100
```

### Limit Order
```bash
npx tsx scripts/operations/limit-order.ts --coin ETH --side buy --size 1 --price 3000
npx tsx scripts/operations/limit-order.ts --coin SOL --side sell --size 10 --price 200 --tif ALO
```

### Cancel Orders
```bash
npx tsx scripts/operations/cancel.ts --all           # cancel all
npx tsx scripts/operations/cancel.ts --coin ETH      # cancel ETH orders
npx tsx scripts/operations/cancel.ts --oid 123456    # cancel specific order
```

## Script Arguments

All scripts support `--dry` for dry run (preview without executing).

### Common Arguments
- `--coin` - Asset symbol (ETH, BTC, SOL, etc.)
- `--dry` - Dry run mode

### Order Arguments
- `--side` - buy or sell
- `--size` - Order size in base asset
- `--price` - Limit price (for limit orders)
- `--slippage` - Slippage tolerance in bps (for market orders)
- `--tif` - Time in force: GTC, IOC, ALO
- `--reduce` - Reduce-only order

## References

See `references/OPERATIONS.md` for detailed operation documentation.

## Risk Warning

- Always use `--dry` first to preview orders
- Start with small sizes on testnet
- Monitor positions and liquidation prices
- Use reduce-only for closing positions
