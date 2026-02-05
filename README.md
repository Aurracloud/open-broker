# Open Broker

Hyperliquid trading CLI. Execute orders, manage positions, and run trading strategies on Hyperliquid DEX.

## Installation

```bash
npm install -g openbroker
```

## Quick Start

```bash
# 1. Setup (generates wallet, creates config, approves builder fee)
openbroker setup

# 2. Fund your wallet with USDC on Arbitrum, then deposit at https://app.hyperliquid.xyz/

# 3. Start trading
openbroker account                          # View account info
openbroker buy --coin ETH --size 0.1        # Market buy
openbroker search --query GOLD              # Find markets
```

## Commands

### Setup
```bash
openbroker setup                # Interactive setup wizard
openbroker approve-builder      # Approve builder fee (one-time)
```

### Account Info
```bash
openbroker account              # Balance, equity, margin
openbroker positions            # Open positions with PnL
openbroker funding --top 20     # Funding rates
openbroker markets --coin ETH   # Market data
openbroker all-markets          # All markets (perps, HIP-3, spot)
openbroker search --query GOLD  # Search across providers
openbroker spot --balances      # Spot balances
```

### Trading
```bash
# Market orders
openbroker buy --coin ETH --size 0.1
openbroker sell --coin BTC --size 0.01

# Limit orders
openbroker limit --coin ETH --side buy --size 1 --price 3000

# TP/SL on existing position
openbroker tpsl --coin HYPE --tp 40 --sl 30
openbroker tpsl --coin ETH --tp +10% --sl -5%

# Cancel orders
openbroker cancel --coin ETH    # Cancel all ETH orders
openbroker cancel --all         # Cancel all orders
```

### Advanced Execution
```bash
# TWAP - split order over time
openbroker twap --coin ETH --side buy --size 1 --duration 3600

# Scale - grid of limit orders
openbroker scale --coin ETH --side buy --size 1 --levels 5 --range 2

# Bracket - entry with TP and SL
openbroker bracket --coin ETH --side buy --size 0.5 --tp 3 --sl 1.5

# Chase - follow price with ALO orders
openbroker chase --coin ETH --side buy --size 0.5 --timeout 300
```

### Strategies
```bash
# Funding arbitrage
openbroker funding-arb --coin ETH --size 5000 --min-funding 25

# Grid trading
openbroker grid --coin ETH --lower 3000 --upper 4000 --grids 10 --size 0.1

# DCA
openbroker dca --coin ETH --amount 100 --interval 1h --count 24

# Market making
openbroker mm-maker --coin HYPE --size 1 --offset 1
```

## Options

| Option | Description |
|--------|-------------|
| `--coin` | Asset symbol (ETH, BTC, SOL, HYPE, etc.) |
| `--side` | Order direction: `buy` or `sell` |
| `--size` | Order size in base asset |
| `--price` | Limit price |
| `--dry` | Preview without executing |
| `--help` | Show command help |

## Safety

**Always use `--dry` first** to preview any operation:

```bash
openbroker buy --coin ETH --size 0.1 --dry
```

**Use testnet** for testing:

```bash
export HYPERLIQUID_NETWORK="testnet"
```

## Configuration

Config is loaded from these locations (in order of priority):
1. Environment variables
2. `.env` file in current directory
3. `~/.openbroker/.env` (global config)

Run `openbroker setup` to create the global config, or set environment variables:

```bash
export HYPERLIQUID_PRIVATE_KEY=0x...     # Required: wallet private key
export HYPERLIQUID_NETWORK=mainnet       # Optional: mainnet (default) or testnet
export HYPERLIQUID_ACCOUNT_ADDRESS=0x... # Optional: for API wallets
```

### API Wallet Setup

For automated trading, use an API wallet:

```bash
export HYPERLIQUID_PRIVATE_KEY="0x..."        # API wallet private key
export HYPERLIQUID_ACCOUNT_ADDRESS="0x..."    # Main account address
```

**Note:** Builder fee must be approved with the main wallet first.

## Builder Fee

Open Broker charges **1 bps (0.01%)** per trade to fund development.

```bash
openbroker approve-builder --check  # Check status
openbroker approve-builder          # Approve (free, no funds needed)
```

## Development

For local development without global install:

```bash
git clone https://github.com/monemetrics/openbroker.git
cd openbroker
npm install
npx tsx scripts/info/account.ts
```

## License

MIT
