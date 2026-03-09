# Changelog

All notable changes to Open Broker will be documented in this file.

## [1.0.52] - 2026-03-09

### Fixed
- **HIP-3 Trading: Isolated Margin**: HIP-3 perps require isolated margin mode (per Hyperliquid docs), but orders were sent without setting it — causing "Insufficient margin to place order" rejections. Now automatically sets isolated margin (3x or asset max, whichever is lower) on first order for each HIP-3 asset. Affects all trading commands: `buy`, `sell`, `market`, `limit`, `trigger`, `tpsl`, `bracket`, `chase`, `twap`, `scale`.

## [1.0.51] - 2026-03-09

### Added
- **Watcher Poll Logging**: Position watcher now logs each poll cycle at debug level — shows position count, equity, and margin usage so you can confirm the watcher is running.

## [1.0.50] - 2026-03-09

### Fixed
- **Plugin `ob_search` HIP-3 Results**: Fixed empty results for HIP-3 assets when using the `ob_search` plugin tool. Added type filter normalization (handles `HIP3`, `HIP-3`, `hip3`, `all`), added `enum` constraint to type parameter schema, surfaced errors instead of silently swallowing them, and aligned HIP-3 iteration with CLI search (index-based with null guards).
- **SKILL.md**: Added "Finding Assets Before Trading" section instructing agents to always search for unfamiliar assets before trading, with examples of `ob_search` and `openbroker search`.

## [1.0.49] - 2026-03-09

### Fixed
- **HIP-3 Asset ID Offset**: Fixed asset ID formula from `dexIdx * 10000 + assetIdx` to `100000 + dexIdx * 10000 + assetIdx`. Orders were routing to spot asset IDs instead of HIP-3 perps, causing "Order price cannot be more than 95% away from the reference price" errors.

## [1.0.48] - 2026-03-09

### Fixed
- **HIP-3 Perp Trading**: All trading commands now work with HIP-3 assets using `dex:COIN` syntax (e.g., `--coin xyz:CL`)
  - `getMetaAndAssetCtxs()` loads HIP-3 dex assets into asset/szDecimals maps (asset index = `100000 + dexIdx * 10000 + assetIdx`)
  - `getAllMids()` fetches and merges mid prices from all HIP-3 dexes
  - Market, limit, trigger, bracket, TWAP, scale, chase orders all work with HIP-3 assets
- **HIP-3 Info Commands**: `funding`, `funding-history`, `candles`, `trades` now return data for HIP-3 assets (previously returned "No data" / null)
- **API Name Format**: Hyperliquid API returns HIP-3 names already prefixed (e.g., `xyz:CL`); fixed double-prefixing bug that caused all HIP-3 lookups to fail
- **Case Normalization**: Added `normalizeCoin()` helper — keeps dex prefix lowercase, uppercases asset (`xyz:cl` → `xyz:CL`). Fixes `toUpperCase()` mangling HIP-3 tickers to `XYZ:CL`
- **Better Error Messages**: When a bare coin name (e.g., `CL`) matches HIP-3 assets, the error now suggests the prefixed ticker (e.g., `xyz:CL`)

### Added
- **Funding Rate Scanner**: New `funding-scan` command for cross-dex funding rate scanning
  - Scans all dexes (main + HIP-3) for high funding opportunities
  - `--pairs` flag identifies opposing funding pairs for delta-neutral strategies
  - `--watch --interval N` for periodic re-scanning
  - `--json` output for piping to alerting systems
  - `--main-only` / `--hip3-only` scope filters
- **HIP-3 Funding Rates**: `funding` and `markets` commands now support `--include-hip3` flag
- **HIP-3 Funding Arb**: `funding-arb` strategy now works with HIP-3 assets (monitoring loop correctly resolves HIP-3 funding data)
- **Plugin**: New `ob_funding_scan` agent tool for cross-dex funding scanning with pairs support
- **Plugin**: `ob_search` now searches HIP-3 perps in addition to main perps and spot
- **Client**: Added `getCoinDex()`, `getCoinLocalName()`, `isHip3()`, `getAllAssetNames()`, `getHip3AssetNames()`, `invalidateMetaCache()` methods
- **Client**: `getPerpDexs()` results are now cached to reduce redundant API calls

## [1.0.44] - 2026-02-25

### Added
- **Trade Fills**: New `fills` command to view trade fill history with prices, fees, and realized PnL
- **Order History**: New `orders` command to view all historical orders (filled, canceled, open, triggered, rejected)
- **Order Status**: New `order-status` command to check the status of a specific order by OID or CLOID
- **Fee Schedule**: New `fees` command to view fee tier, maker/taker rates, referral/staking discounts, and daily volumes
- **Candle Data**: New `candles` command to view OHLCV candlestick data with configurable intervals and bar counts
- **Funding History**: New `funding-history` command to view historical funding rates for any asset
- **Recent Trades**: New `trades` command to view the tape (time & sales) for an asset with buy/sell volume breakdown
- **Rate Limit**: New `rate-limit` command to check API rate limit usage, capacity, and cumulative volume
- **Cumulative Funding on Positions**: The `positions` command now shows cumulative funding received/paid per position
- **Client Extensions**: Added 9 new methods to HyperliquidClient
  - `getUserFunding()` - Funding ledger updates
  - `getUserFills()` - Trade fill history
  - `getHistoricalOrders()` - All orders with statuses
  - `getOrderStatus()` - Single order lookup
  - `getUserFees()` - Fee schedule and volume
  - `getCandleSnapshot()` - OHLCV candle data
  - `getFundingHistory()` - Historical funding rates per asset
  - `getRecentTrades()` - Recent trades for an asset
  - `getUserRateLimit()` - API rate limit status
- **Plugin Tools**: Added 8 new OpenClaw plugin tools
  - `ob_fills`, `ob_orders`, `ob_order_status`, `ob_fees`
  - `ob_candles`, `ob_funding_history`, `ob_trades`, `ob_rate_limit`

## [1.0.37] - 2025-02-08
- **Detailed Docs**: Adding detailed docs for all sub commands

## [1.0.36] - 2025-02-06

### Changed
- **Streamlined Setup**: Builder fee approval is now clearly part of `openbroker setup`
  - Single command does wallet creation, config save, and builder approval
  - Updated docs to clarify approval is automatic
  - `approve-builder` moved to utility section (for retry/troubleshooting)

## [1.0.35] - 2025-02-05

### Fixed
- Suppressed Node.js experimental warnings for cleaner CLI output

## [1.0.34] - 2025-02-05

### Changed
- **Global Config**: Config now stored in `~/.openbroker/.env` for global CLI usage
  - Config loaded from: env vars > local `.env` > `~/.openbroker/.env`
  - `openbroker setup` creates config in home directory
  - Works from any directory without local `.env` file
- **Read-Only Mode**: Info commands work without configuration
  - Market data, funding rates, search all work immediately
  - Shows warning: "Not configured for trading. Run openbroker setup to enable trades."
  - Trading commands fail with clear error until configured
- **Better Error Messages**: Clear instructions when config missing

## [1.0.3] - 2025-02-05

### Added
- **CLI Package**: Now installable as global CLI via `npm install -g openbroker`
  - Single `openbroker` command with subcommands
  - Shortcuts: `openbroker buy`, `openbroker sell` for quick market orders
  - Full help: `openbroker --help`
- **All Markets View**: New `all-markets.ts` script to view markets across all venues
  - Shows main perps, HIP-3 perps, and spot markets in one view
  - Filter by type: `--type perp`, `--type hip3`, `--type spot`
  - Sort by 24h volume
- **Market Search**: New `search-markets.ts` script to find assets across providers
  - Search by coin name: `--query GOLD`, `--query BTC`
  - Shows funding comparison when same asset available on multiple HIP-3 providers
  - Displays price, volume, funding, and open interest
- **Spot Markets**: New `spot.ts` script for spot market info
  - View all spot trading pairs with prices and volumes
  - Check spot token balances with `--balances`
  - Filter by coin: `--coin PURR`
- **Client Extensions**: Added new methods to HyperliquidClient
  - `getPerpDexs()` - Get all perp DEXs including HIP-3
  - `getAllPerpMetas()` - Get all perp markets across venues
  - `getSpotMeta()` - Spot market metadata
  - `getSpotMetaAndAssetCtxs()` - Spot metadata with prices/volumes
  - `getSpotBalances()` - User's spot token balances
  - `getTokenDetails()` - Token info by ID
  - `getPredictedFundings()` - Predicted funding rates across venues

## [1.0.2] - 2025-02-05

### Added
- **Trigger Orders**: New `trigger-order.ts` script for standalone stop loss and take profit orders
- **Set TP/SL**: New `set-tpsl.ts` script to add TP/SL to existing positions
  - Supports absolute prices (`--tp 40`)
  - Supports percentage from entry (`--tp +10%`, `--sl -5%`)
  - Supports breakeven (`--sl entry`)
  - Validates TP/SL make sense for position direction
  - Calculates and displays risk/reward ratio
- **Order Types Documentation**: Clear explanation of limit orders vs trigger orders in SKILL.md

### Fixed
- TIF case sensitivity issue in `limit-order.ts` and `scale.ts` (SDK expects "Gtc" not "GTC")
- Path resolution for `.env` file when packaged as skill
- Suppressed dotenv logging noise with `DOTENV_CONFIG_QUIET`

## [1.0.1] - 2025-02-05

### Added
- **Automated Onboarding**: New `onboard.ts` script for one-command setup
  - Prompts user to use existing key or generate new wallet
  - Creates `.env` file automatically
  - Approves builder fee (free, no funds needed)
  - Displays wallet address for funding
- Interactive wallet setup flow for AI agents

### Changed
- Updated SKILL.md and README.md with simplified onboarding instructions
- Config now gracefully handles missing `.env` file with helpful error messages

## [1.0.0] - 2025-02-04

### Added
- **Core Trading**
  - Market orders with slippage protection
  - Limit orders (GTC, IOC, ALO)
  - Order cancellation
  - Position management

- **Advanced Execution**
  - TWAP (Time-Weighted Average Price)
  - Scale in/out with price distribution
  - Bracket orders (entry + TP + SL)
  - Chase orders (follow price with ALO)

- **Trading Strategies**
  - Funding arbitrage
  - Grid trading
  - DCA (Dollar Cost Averaging)
  - Market making (spread and maker-only)

- **Info Scripts**
  - Account overview
  - Position details
  - Funding rates
  - Market data

- **Builder Fee Support**
  - 1 bps (0.01%) fee on trades
  - One-time approval flow
  - API wallet support
