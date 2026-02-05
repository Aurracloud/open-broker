# Changelog

All notable changes to Open Broker will be documented in this file.

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
