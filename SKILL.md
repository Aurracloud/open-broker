---
name: openbroker
description: Hyperliquid trading CLI skill for agents. Use when an agent needs to inspect markets/accounts, place or manage perp/spot/HIP-4 orders, or write and run Hyperliquid trading automations directly through the `openbroker` CLI without requiring the OpenClaw plugin.
license: MIT
compatibility: Requires Node.js 22+, network access to api.hyperliquid.xyz
homepage: https://www.npmjs.com/package/openbroker
metadata: {"author": "monemetrics", "version": "1.3.1"}
allowed-tools: Bash(openbroker:*)
---

# OpenBroker — Hyperliquid CLI skill

OpenBroker is first a CLI. The OpenClaw plugin is optional: use `ob_*` tools when present for common structured calls, but keep the CLI model in mind because it is the complete surface area and the safest fallback.

## Operating rules

- For unfamiliar assets, **search before trading**. Hyperliquid has main perps, HIP-3 perps, spot markets, and HIP-4 outcomes that can share names.
- Prefer `--json` for machine-readable info commands.
- Before any write, verify the asset, account, open positions/orders, size, and whether the action should be reduce-only.
- For new or changed trading logic, start with `--dry`, inspect the plan/audit trail, then go live only when that matches the user’s intent.
- Treat CLI output as exchange state, not just prose: parse order IDs, balances, fills, and errors instead of assuming success.

## Setup and identity

```bash
npm install -g openbroker
openbroker setup
openbroker account --json
```

`setup` supports:

1. **Fresh wallet** — simplest for agents; builder fee approval is handled automatically.
2. **Imported key** — use an existing wallet.
3. **API wallet** — can trade but not withdraw; the human owner must approve it in a browser.

For API wallets, `HYPERLIQUID_PRIVATE_KEY` is the signing key and `HYPERLIQUID_ACCOUNT_ADDRESS` must be the funded master account. If account output shows `$0` equity unexpectedly, check that mapping first.

Common globals:

| Flag | Meaning |
|---|---|
| `-c, --config <path>` | Use a specific `.env` file |
| `--testnet` | Use testnet |
| `--dry` | Preview write commands without executing |
| `--verbose` | Debug output |
| `--json` | Machine-readable output on info commands |

## Asset discovery and IDs

```bash
openbroker search --query GOLD --json
openbroker search --query BTC --type perp --json
openbroker all-markets --type hip3 --json
openbroker outcomes --query BTC --json
```

- HIP-3 perps use `dex:COIN`, e.g. `xyz:CL`, not bare `CL`.
- `assetId` is the canonical identifier for comparisons and persisted agent state; order placement still uses `--coin`.
- HIP-4 outcome orders use `--outcome <id|#encoding|+encoding>` plus `--outcome-side yes|no` when the reference is a plain ID.
- On testnet, HIP-3 metadata may need an explicit prefixed coin such as `dex:COIN`.

## CLI command map

### Info commands

Most info commands accept `--json`. Use `--coin`, `--top`, and `--address` where the command supports them rather than repeating bespoke parsing logic.

| Command | Main use | Distinct flags |
|---|---|---|
| `account` | Equity, margin, spot balances, positions | `--orders`, `--address` |
| `positions` | Open perp positions and liquidation distance | `--coin`, `--address` |
| `funding` | Funding rates | `--coin`, `--top`, `--sort annualized|hourly|oi`, `--all`, `--include-hip3` |
| `markets` | Perp market data | `--coin`, `--top`, `--sort volume|oi|change`, `--include-hip3` |
| `all-markets` | Browse every venue type | `--type perp|hip3|spot|outcome|all`, `--top` |
| `search` | Find markets across providers | `--query`, `--type` |
| `spot` | Spot markets or balances | `--coin`, `--balances`, `--address`, `--top` |
| `fills` | Recent fills | `--coin`, `--side buy|sell`, `--top`, `--address` |
| `orders` | Order history/open orders | `--coin`, `--status`, `--open`, `--top`, `--address` |
| `order-status` | One order by exchange/client ID | `--oid`, `--address` |
| `fees` | Fee tier and rates | `--address` |
| `candles` | OHLCV | `--coin`, `--interval`, `--bars` |
| `funding-history` | Historical funding | `--coin`, `--hours` |
| `trades` | Recent tape | `--coin`, `--top` |
| `rate-limit` | API usage | — |
| `funding-scan` | Cross-dex scan | `--threshold`, `--main-only`, `--hip3-only`, `--pairs`, `--watch`, `--interval`, `--top` |
| `outcomes` | HIP-4 discovery/balances | `--query`, `--outcome`, `--side`, `--balances`, `--top` |

### Perp trading

Shared perp order flags:

| Flag | Meaning |
|---|---|
| `--coin <COIN>` | Main perp or HIP-3 `dex:COIN` |
| `--side buy|sell` | Required except `buy` / `sell` shortcuts |
| `--size <SIZE>` | Base-asset size |
| `--leverage <N>` | Main perps use cross; HIP-3 uses isolated |
| `--reduce` | Reduce-only; use when closing/reducing exposure |
| `--slippage <bps>` | Market/SL slippage tolerance |

| Command | Shape |
|---|---|
| `buy`, `sell` | Market shortcuts: `openbroker buy --coin ETH --size 0.1` |
| `market` | Explicit market order with `--side` |
| `limit` | Add `--price` and optional `--tif GTC|IOC|ALO` |
| `trigger` | Add `--trigger`, `--type tp|sl`, optional `--limit` |
| `tpsl` | Protect an existing position with `--tp` and/or `--sl`; accepts absolute, `%`, or `entry` forms |
| `cancel` | `--all`, `--coin`, or `--oid` |

### Spot and HIP-4 outcome trading

| Family | Commands | Shared flags |
|---|---|---|
| Spot | `spot-buy`, `spot-sell`, `spot-order` | `--coin`, `--side`, `--size`, optional `--price`, `--tif Gtc|Ioc|Alo`, `--slippage` |
| Outcomes | `outcome-buy`, `outcome-sell`, `outcome-open`, `outcome-close`, `outcome-order` | `--outcome`, `--outcome-side`, `--side`, `--size`, optional `--price`, `--tif`, `--slippage`, `--sz-decimals` |

### Advanced execution

| Command | Use | Distinct flags |
|---|---|---|
| `twap` | Exchange-managed TWAP | `--duration`, `--randomize`, `--reduce-only` |
| `twap-cancel` | Stop a TWAP | `--coin`, `--twap-id` |
| `twap-status` | Inspect TWAPs | `--active` |
| `scale` | Multi-level ladder | `--levels`, `--range`, `--distribution linear|exponential|flat`, `--tif` |
| `bracket` | Entry + TP + SL | `--entry market|limit`, `--price`, `--tp`, `--sl` |
| `chase` | Repriced ALO order | `--offset`, `--timeout`, `--interval`, `--max-chase` |

## High-signal workflows

Inspect before trading:

```bash
openbroker search --query HYPE --json
openbroker account --orders --json
openbroker positions --json
openbroker markets --coin HYPE --json
openbroker buy --coin HYPE --size 1 --dry
```

Close rather than flip:

```bash
openbroker positions --coin ETH --json
openbroker sell --coin ETH --size 0.1 --reduce --dry
```

For large or passive execution, prefer `limit`, `chase`, `scale`, or `twap` over a blind market order.

## Automations

Automations are TypeScript scripts run by the CLI:

```bash
openbroker auto run <script> [--id <name>] [--set key=value] [--poll <ms>] [--dry]
```

Management commands:

| Command | Use |
|---|---|
| `auto examples` | Inspect bundled examples and schemas |
| `auto run <script>` | Run a custom script by path or from `~/.openbroker/automations/` |
| `auto list` | List available automations |
| `auto status` | Show running automations |
| `auto stop <id>` | Unregister/stop an automation |
| `auto report <id>` | Summarize audit data |
| `auto clean` | Reconcile stale registry entries |
| `auto prune ...` | Delete old audit runs |

Run flags:

| Flag | Meaning |
|---|---|
| `--set key=value` | Repeatable typed config values |
| `--id <name>` | Stable automation ID |
| `--poll <ms>` | Poll interval, minimum 1000 ms |
| `--dry` | Intercept write methods |
| `--no-ws` | Disable WebSocket and rely on REST polling |
| `--allow-sleep` | Do not request OS sleep inhibition |

Bundled examples are **references, not production strategies**. Read them for API patterns, then write a purpose-built script with explicit sizing, exit logic, and failure behavior.

### Automation API essentials

- `api.client` — full Hyperliquid client.
- `api.on(...)`, `api.every(...)`, `api.onStart(...)`, `api.onStop(...)`, `api.onError(...)`.
- `api.state` — persisted state; survives restarts.
- `api.audit.record(...)` / `api.audit.metric(...)` — durable observability.
- `api.publish(...)` — notify an OpenClaw agent when hooks are configured.
- `api.dryRun` — whether writes are intercepted.

Core events include `tick`, `price_change`, `funding_update`, `position_opened`, `position_closed`, `position_changed`, `pnl_threshold`, `margin_warning`, `order_filled`, `order_update`, and `liquidation`.

### Monitoring and dashboard

`openbroker-monitoring` is optional but useful for long-running automations, live debugging, and post-run inspection.

```bash
npm install openbroker-monitoring
openbroker auto run ./my-automation.ts --id my-auto
openbroker-monitoring serve --host 127.0.0.1 --port 3001
```

- The local dashboard reads `~/.openbroker/automation-audit.sqlite` directly; it works for any standard `openbroker auto run` automation and does **not** need vault config, webhooks, or remote forwarding.
- Configure it with `OB_MONITOR_HOST`, `OB_MONITOR_PORT`, or `OPENBROKER_AUDIT_DB_PATH`, or the equivalent `serve --host/--port/--db` flags.
- When installed alongside OpenBroker, the package is convention-loaded as an audit observer. Remote forwarding is separate and only activates when `OB_DASHBOARD_URL` plus `HYPERSTABLE_VAULT_ADDRESS` or `VAULT` are configured; `OB_DASHBOARD_API_KEY` is optional.
- Start the dashboard when the user wants a live view, troubleshooting help, or ongoing monitoring. It is helpful infrastructure, not a prerequisite for every automation.

### Hyperliquid automation design rules

These matter more than boilerplate:

1. **Model the strategy as a state machine.** Persist flags, streaks, targets, and recovery state with `api.state`; handlers can fire repeatedly and processes can restart.
2. **Use hysteresis, not one-print decisions.** Confirmation loops, separate enter/exit thresholds, and debounce logic prevent churn from noisy funding or tiny price moves.
3. **Use the freshest correct signal.** For funding strategies, prefer `getPredictedFundings()` when available; if you fall back to instantaneous funding from metadata, ensure the metadata cache is refreshed so the signal does not freeze after startup.
4. **Price the flip, not just the signal.** Before closing and later reopening a carry, compare expected hold cost with round-trip trading cost. The HYPE carry automation counts maker fees across both legs plus builder fees before deciding whether a mildly negative funding window is worth exiting.
5. **Respect settlement timing.** If the current predicted funding is still positive, a close right before hourly settlement can be economically wrong even when the broader signal weakened. Add a settlement-proximity guard when the strategy depends on funding capture.
6. **Sequence multi-leg hedges deliberately.** For spot-long / perp-short carry, build spot first, then short only up to spot-backed exposure; unwind spot first, then close the short reduce-only. Recover accidental one-sided exposure explicitly instead of pretending it cannot happen.
7. **Separate strategy logic from execution policy.** Maker-first execution can reduce fees, but it needs bounded retries, post-only rejection handling, order cancellation, partial-fill accounting, minimum trade thresholds, and a defined IOC fallback. Measure progress from refreshed balances/positions, not only from submit responses.
8. **Size from real NAV and hard caps.** Multi-leg strategies often need spot balances, spot USDC, and perp account value combined; a 50/50 carry target derived from total NAV must then be halved per side and still respect a hard per-side cap.
9. **Define stop behavior intentionally.** On shutdown, always handle working orders, but do not blindly flatten every strategy. A hedged carry may need “preserve hedge and alert,” while a transient execution bot may need “cancel and flatten.”
10. **Instrument first-class decisions.** Log and audit funding source, targets, leg notionals, settlement distance, hold/close decisions, fills, retries, and error paths. If using the plugin, publish events that need human attention.

Additional practical caveats:

- Positive-funding carry and negative-funding carry are not automatically symmetric. If the hedge requires short spot and the client/runtime cannot express that safely, do not invent an unhedged mirror trade.
- `funding_update` fires for many assets every poll; filter by coin early.
- Dust matters: if residual size falls below exchange precision or `minTradeUsd`, stop chasing it.
- `ALO` / post-only orders can be rejected when they would cross; treat that as an execution branch, not a surprise.
- Naked directional positions usually need explicit TP/SL or equivalent risk logic. Hedged multi-leg strategies need strategy-specific exits instead of cargo-cult TP/SL rules.
- For new automations, do a dry run, inspect `auto report`, and only then run live unless the user explicitly requested immediate live execution.

## Plugin-aware use

When the OpenClaw plugin is available:

- Prefer `ob_*` tools for common structured reads and simple writes.
- Use `ob_watcher_status` for background monitoring state.
- Use `ob_auto_run`, `ob_auto_stop`, and `ob_auto_list` for supported automation actions.
- Fall back to the CLI for unsupported commands, debugging, richer flags, or if a tool returns empty/unexpected data.

Representative mappings:

| Plugin tool | CLI equivalent |
|---|---|
| `ob_account` | `openbroker account --json` |
| `ob_positions` | `openbroker positions --json` |
| `ob_funding` | `openbroker funding --json --include-hip3` |
| `ob_search` | `openbroker search --query <QUERY> --json` |
| `ob_buy` / `ob_sell` | `openbroker buy|sell --coin <COIN> --size <SIZE>` |
| `ob_limit` | `openbroker limit ...` |
| `ob_tpsl` | `openbroker tpsl ...` |
| `ob_auto_run` | `openbroker auto run <script> ...` |

Skill-only mode is fully usable through the CLI; the plugin adds agent tools, watcher notifications, and OpenClaw webhook integration.

## Failure checks

- `No market data found` → search again; likely wrong venue prefix.
- `$0` equity on an API wallet → likely missing `HYPERLIQUID_ACCOUNT_ADDRESS`.
- Unexpected funding behavior → check whether you are reading predicted vs cached instantaneous data.
- Strategy churn → inspect confirmation loops, fee-aware hold logic, settlement guards, and min-trade thresholds before changing position size.
- Tool failure in plugin mode → rerun the equivalent CLI command with `--json` and `--verbose` if needed.
