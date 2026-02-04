# Open Broker - Operations Reference

## Info Scripts

### account.ts
Display account summary including equity, margin, and positions.

```bash
npx tsx scripts/info/account.ts [--orders]
```

**Output:**
- Account value and margin used
- Withdrawable balance
- Positions summary (if any)
- Open orders (with --orders flag)

### positions.ts
Display detailed position information.

```bash
npx tsx scripts/info/positions.ts [--coin <COIN>]
```

**Output:**
- Entry price and current mark
- Unrealized PnL and ROE
- Liquidation price and distance
- Leverage and margin used

### funding.ts
Display funding rates across all markets.

```bash
npx tsx scripts/info/funding.ts [--top <N>] [--coin <COIN>] [--sort <TYPE>] [--all]
```

**Arguments:**
- `--top` - Number of results (default: 20)
- `--coin` - Filter to specific coin
- `--sort` - Sort by: annualized, hourly, oi (default: annualized)
- `--all` - Include low OI markets

**Output:**
- Hourly funding rate
- Annualized rate (hourly × 8760)
- Premium (mark vs oracle)
- Open interest
- High funding opportunities

### markets.ts
Display market data and metadata.

```bash
npx tsx scripts/info/markets.ts [--top <N>] [--coin <COIN>] [--sort <TYPE>]
```

**Arguments:**
- `--top` - Number of results (default: 30)
- `--coin` - Show detailed view for single coin
- `--sort` - Sort by: volume, oi, change (default: volume)

**Output:**
- Mark and oracle prices
- 24h change and volume
- Open interest
- Max leverage and size decimals

---

## Trading Operations

### market-order.ts
Execute market order with slippage protection.

```bash
npx tsx scripts/operations/market-order.ts \
  --coin <COIN> \
  --side <buy|sell> \
  --size <SIZE> \
  [--slippage <BPS>] \
  [--reduce] \
  [--dry]
```

**How it works:**
1. Gets current mid price
2. Calculates limit price with slippage buffer
3. Submits IOC (Immediate or Cancel) order
4. Reports fill details

**Arguments:**
- `--coin` - Asset to trade (ETH, BTC, etc.)
- `--side` - buy or sell
- `--size` - Size in base asset
- `--slippage` - Slippage tolerance in bps (default: 50 = 0.5%)
- `--reduce` - Reduce-only (for closing positions)
- `--dry` - Preview without executing

### limit-order.ts
Place limit order at specified price.

```bash
npx tsx scripts/operations/limit-order.ts \
  --coin <COIN> \
  --side <buy|sell> \
  --size <SIZE> \
  --price <PRICE> \
  [--tif <GTC|IOC|ALO>] \
  [--reduce] \
  [--dry]
```

**Time in Force options:**
- `GTC` - Good Till Cancel (default): Rests on book until filled or cancelled
- `IOC` - Immediate Or Cancel: Fills immediately or cancels unfilled portion
- `ALO` - Add Liquidity Only: Post-only, rejected if would take liquidity

**Arguments:**
- `--coin` - Asset to trade
- `--side` - buy or sell
- `--size` - Size in base asset
- `--price` - Limit price
- `--tif` - Time in force (default: GTC)
- `--reduce` - Reduce-only
- `--dry` - Preview without executing

### cancel.ts
Cancel open orders.

```bash
npx tsx scripts/operations/cancel.ts \
  [--coin <COIN>] \
  [--oid <ORDER_ID>] \
  [--all] \
  [--dry]
```

**Modes:**
- `--all` - Cancel all open orders
- `--coin` - Cancel all orders for specific coin
- `--oid` - Cancel specific order by ID

---

## Hyperliquid Specifics

### Funding
- Paid/received **hourly** (not 8h like most CEXs)
- Annualized = hourly × 8760
- Positive rate: longs pay shorts
- Negative rate: shorts pay longs

### Order Types
- **Limit GTC**: Standard resting order
- **Limit IOC**: Market order with price protection
- **Limit ALO**: Maker-only, guaranteed rebate

### Price/Size Rounding
- Prices: 5 significant figures, max 6 decimals
- Sizes: Asset-specific szDecimals (e.g., ETH=4, BTC=5)

### Leverage
- Cross margin: Shared across positions
- Isolated margin: Per-position margin
- Default: Cross margin

### Builder Fee
All orders include builder fee for open-broker revenue.
- Default: 1 bps (0.01%)
- Configurable via BUILDER_FEE env var
