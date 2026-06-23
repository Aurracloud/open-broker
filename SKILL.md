---
name: openbroker
description: Install, onboard, and operate the OpenBroker Hyperliquid CLI for market and account inspection, restricted API-wallet setup, perp/HIP-3/spot/HIP-4 trading, order management, and TypeScript automations. Use when Codex needs to set up OpenBroker, run or explain `openbroker` commands, inspect Hyperliquid state, safely preview or execute trades, or create and debug OpenBroker automations.
---

# OpenBroker — Hyperliquid CLI skill

Use the `openbroker` CLI as the canonical interface. Prefer structured JSON output for inspection and dry runs before live writes.

## Operating rules

- For unfamiliar assets, **search before trading**. Hyperliquid has main perps, HIP-3 perps, spot markets, and HIP-4 outcomes that can share names.
- Prefer `--json` for machine-readable info commands.
- Before any write, verify the network, trading account, asset, side, size, open positions/orders, and whether the action should be reduce-only.
- Use `--dry` for proposed trades and new or changed trading logic. Execute live only when the user explicitly requests live execution and the dry-run plan matches that intent.
- Never infer a live trade size, switch to mainnet, or create/import/export a wallet without explicit user direction.
- Never print, echo, log, or expose private keys or seed material. Refer only to the configured signing wallet address when diagnosing identity.
- Treat CLI output as exchange state, not just prose: parse order IDs, balances, fills, and errors instead of assuming success.

## First-run installation and API-wallet onboarding

Use the following flow when the user asks to install, set up, or use OpenBroker. Do not ask the user for a private key.

For a fresh Codex installation, prefer the unified harness installer:

```bash
npx --yes openbroker@latest install --codex
```

This installs or updates the Codex skill, installs the persistent `openbroker` CLI, and starts restricted API-wallet onboarding. Keep the command attached while it prints the browser approval link and polls for authorization.

If the unified installer is unavailable or the skill is already installed, first check whether Node.js 22+ and the CLI are installed:

```bash
node --version
command -v openbroker
openbroker --version
```

Require OpenBroker 1.9.1 or newer. When the user explicitly asks to set up OpenBroker, install or upgrade the CLI as part of that request, using the normal approval flow for global or network writes:

```bash
npm install -g openbroker@latest
```

Public market-data commands such as `search`, `markets`, `funding`, `candles`, and `trades` work without wallet setup. For account-specific reads or trading, prefer a restricted API wallet because it can trade on the user's master Hyperliquid account but cannot withdraw funds.

Run setup in an interactive terminal session and select the API-wallet flow directly:

```bash
openbroker setup --api-wallet
```

The command generates and stores the API wallet key locally in `~/.openbroker/.env` with mode `0600`, prints an approval URL, and waits up to ten minutes for browser approval. Handle that handoff as follows:

1. Keep the setup process running. Polling output is expected; do not treat it as a stuck command.
2. Capture the `https://openbroker.dev/approve?agent=...` URL from terminal output and immediately show it to the user as a clickable link.
3. Ask the user to open the link, connect the funded master Hyperliquid wallet they want OpenBroker to trade on, review the addresses and network, and sign the requested approvals. On mainnet this authorizes the API agent and the 1 bps builder fee; it does not grant withdrawal access.
4. Never ask the user to paste a master-wallet or API-wallet private key into Codex. Never display the key or read the config file into the conversation.
5. Leave the terminal session running while the user completes approval. The CLI detects approval automatically and saves `HYPERLIQUID_ACCOUNT_ADDRESS` as the master account.
6. After setup completes, verify the connection with `openbroker account --json` and report the master account address, API signing-wallet address, account mode, and equity without exposing secrets.

If approval times out, preserve the incomplete config and approval URL. Ask the user to finish approval, then rerun `openbroker setup --api-wallet`; the CLI reuses the existing API key and resumes polling instead of generating another wallet.

If a complete config already exists, do not delete or replace it without explicit user approval. Inspect account identity with `openbroker account --json` first.

The interactive `openbroker setup` command still supports three modes, with API wallet as the default when the user presses Enter:

1. **Fresh wallet** — creates a separately funded wallet; builder fee approval is handled automatically.
2. **Imported key** — use an existing wallet.
3. **API wallet (default)** — can trade but not withdraw; the human owner approves it in a browser.

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
openbroker all-markets --type outcome --json
openbroker outcomes --query BTC --json
```

- HIP-3 perps use `dex:COIN`, e.g. `xyz:CL`, not bare `CL`.
- `assetId` is the canonical identifier for comparisons and persisted agent state; order placement still uses `--coin`.
- For HIP-4 discovery, use `outcomes --json` for grouped market metadata and `all-markets --type outcome --json` for flattened side rows.
- HIP-4 outcome orders use `--outcome <id|#encoding|+encoding>` plus `--outcome-side yes|no` when the reference is a plain ID. Encoded sides use `encoding = 10 * outcomeId + side`, where side `0` is the first side and side `1` is the second side.
- HIP-4 order books use `#<encoding>` coins; spot balances may show `+<encoding>` token names.
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
| `all-markets` | Browse every venue type | `--type perp|hip3|spot|outcome|all`, `--top`, `--json` |
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
| `outcomes` | HIP-4 discovery/balances | `--query`, `--outcome`, `--side`, `--balances`, `--top`, `--json` |

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
| `--poll <ms>` | REST fallback interval, minimum 1000 ms. While WebSocket is healthy, REST reconciliation is capped at once per minute. |
| `--dry` | Intercept write methods |
| `--no-ws` | Disable WebSocket and rely on REST polling |
| `--allow-sleep` | Do not request OS sleep inhibition |

Bundled examples are **references, not production strategies**. Read them for API patterns, then write a purpose-built script with explicit sizing, exit logic, and failure behavior.

### Required guardrail contract

Every automation module must export both `guardrails` and a default factory. Validation runs before the factory or any `onStart` hook. A missing, malformed, or internally inconsistent policy prevents startup.

Use a read-only policy for monitoring and alerting:

```ts
import type { AutomationAPI, AutomationGuardrails } from 'openbroker';

export const guardrails: AutomationGuardrails = { mode: 'read-only' };

export default function monitor(api: AutomationAPI) {
  api.on('price_change', ({ coin, changePct }) => api.log.info(`${coin}: ${changePct}%`));
}
```

Read-only mode blocks every client write. Trading policies must declare every field below:

```ts
import type { AutomationAPI, AutomationGuardrails } from 'openbroker';

export const guardrails: AutomationGuardrails = {
  mode: 'trading',
  allowedMarkets: ['ETH'],       // ETH, xyz:CL, spot:HYPE, or #<outcome encoding>
  maxOrderUsd: 500,
  maxPositionUsd: 1_000,
  maxTotalExposureUsd: 2_500,
  maxLeverage: 2,
  maxMarginUsedPct: 50,
  maxOpenOrders: 10,
  maxOrdersPerMinute: 6,
  maxSlippageBps: 50,
  allowMarketOrders: true,
  allowAccountWideCancel: false,
};

export default function strategy(api: AutomationAPI) {
  // Risk-increasing perp orders must pass leverage explicitly.
  api.onStart(() => api.client.limitOrder('ETH', true, 0.1, 2_000, 'Gtc', false, 2));
}
```

When allowed markets depend on `--set` values, export a factory such as `guardrails({ config }) { ... }`; the returned object is still strictly validated. Wildcard markets and unknown policy fields are rejected.

All `api.client` write methods cross the runtime policy proxy in live and `--dry` modes. Before risk-increasing orders, the runtime refreshes account positions, spot balances, prices, margin, and open orders; calculates projected per-market and total exposure; enforces leverage, margin, order-count, rate, market-order, and slippage limits; then either submits or throws `GuardrailViolation`. Blocks are logged and written to the audit trail as `guardrail_block`. Cancellations and genuinely risk-reducing orders remain available when exposure or margin is already above its cap, but market allowlists and explicit account-wide-cancel policy still apply. Administrative writes such as `approveBuilderFee` are always blocked inside automations.

Treat `api.client` as the only supported execution path. Automation files are trusted TypeScript running in-process, not an OS sandbox; direct exchange SDK imports would bypass the runtime boundary and must not be generated or accepted during review.

### Automation API essentials

- `api.client` — full Hyperliquid client.
- `api.on(...)`, `api.every(...)`, `api.onStart(...)`, `api.onStop(...)`, `api.onError(...)`.
- `api.state` — persisted state; survives restarts.
- `api.audit.record(...)` / `api.audit.metric(...)` — durable observability.
- `api.dryRun` — whether writes are intercepted.
- `api.guardrails` — validated policy currently enforced by the runtime.

Core events include `tick`, `price_change`, `funding_update`, `position_opened`, `position_closed`, `position_changed`, `pnl_threshold`, `margin_warning`, `order_filled`, `order_update`, and `liquidation`.

### WebSocket-first runtime

WebSocket mode is enabled by default. Before `onStart`, the runtime subscribes to:

- `allMids` for instant perp and spot prices;
- `allDexsAssetCtxs` for funding, mark, oracle, open-interest, and premium changes;
- `allDexsClearinghouseState` plus `spotState` for positions, margin, collateral, and balances;
- `openOrders` for the native dex and every active HIP-3 dex so guardrail order-count checks stay live;
- `orderUpdates`, `userFills`, and `userEvents` for order lifecycle, fills, funding payments, and liquidations;
- `l2Book` lazily, the first time an automation requests a book for a coin.

The normal `api.client` read methods are WebSocket-aware inside automations. `getAllMids()`, `getMetaAndAssetCtxs()`, `getUserState()`, `getUserStateAll()`, `getSpotBalances()`, `getOpenOrders()`, and `getL2Book()` return fresh socket data when available and transparently fall back to REST when the socket is disconnected, a subscription has not seeded yet, or live market data is stale. Automation code should keep using `api.client`; do not import a second exchange SDK or create a second socket.

`api.every(intervalMs, handler)` runs on an independent scheduler and no longer causes a REST snapshot. `--poll` controls the disconnected fallback cadence. While the socket is healthy, the runtime performs a REST reconciliation no more than once per minute, even when an older launch command passes `--poll 5000`. Predicted cross-venue funding has no equivalent socket feed, so `getPredictedFundings()` is de-duplicated, cached for 60 seconds, and serves the last good value if a refresh is temporarily rate-limited.

Use `--no-ws` only for debugging or networks that cannot maintain WebSockets. In that mode, `--poll` is the active REST cadence and event latency follows it.

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
3. **Use the freshest correct signal.** Instantaneous funding and prices are WebSocket-backed by default. Prefer `getPredictedFundings()` for cross-venue forecasts; the runtime refreshes that REST-only signal at most once per minute and retains the last good value through transient rate limits.
4. **Price the flip, not just the signal.** Before closing and later reopening a carry, compare expected hold cost with round-trip trading cost. The HYPE carry automation counts maker fees across both legs plus builder fees before deciding whether a mildly negative funding window is worth exiting.
5. **Respect settlement timing.** If the current predicted funding is still positive, a close right before hourly settlement can be economically wrong even when the broader signal weakened. Add a settlement-proximity guard when the strategy depends on funding capture.
6. **Sequence multi-leg hedges deliberately.** For spot-long / perp-short carry, build spot first, then short only up to spot-backed exposure; unwind spot first, then close the short reduce-only. Recover accidental one-sided exposure explicitly instead of pretending it cannot happen.
7. **Separate strategy logic from execution policy.** Maker-first execution can reduce fees, but it needs bounded retries, post-only rejection handling, order cancellation, partial-fill accounting, minimum trade thresholds, and a defined IOC fallback. Measure progress from refreshed balances/positions, not only from submit responses.
8. **Size from real NAV and hard caps.** Multi-leg strategies often need spot balances, spot USDC, and perp account value combined; a 50/50 carry target derived from total NAV must then be halved per side and still respect a hard per-side cap.
9. **Define stop behavior intentionally.** On shutdown, always handle working orders, but do not blindly flatten every strategy. A hedged carry may need “preserve hedge and alert,” while a transient execution bot may need “cancel and flatten.”
10. **Instrument first-class decisions.** Log and audit funding source, targets, leg notionals, settlement distance, hold/close decisions, fills, retries, and error paths. Surface events that need human attention through the configured monitoring path.

Additional practical caveats:

- Positive-funding carry and negative-funding carry are not automatically symmetric. If the hedge requires short spot and the client/runtime cannot express that safely, do not invent an unhedged mirror trade.
- `funding_update` is emitted from changed WebSocket asset contexts and may cover many assets; filter by coin early.
- Dust matters: if residual size falls below exchange precision or `minTradeUsd`, stop chasing it.
- `ALO` / post-only orders can be rejected when they would cross; treat that as an execution branch, not a surprise.
- Naked directional positions usually need explicit TP/SL or equivalent risk logic. Hedged multi-leg strategies need strategy-specific exits instead of cargo-cult TP/SL rules.
- For new automations, do a dry run, inspect `auto report`, and only then run live unless the user explicitly requested immediate live execution.

## Failure checks

- `No market data found` → search again; likely wrong venue prefix.
- `$0` equity on an API wallet → likely missing `HYPERLIQUID_ACCOUNT_ADDRESS`.
- Unexpected funding behavior → check whether you are reading predicted vs cached instantaneous data.
- Strategy churn → inspect confirmation loops, fee-aware hold logic, settlement guards, and min-trade thresholds before changing position size.
- Unexpected or empty CLI output → rerun the command with `--json` and `--verbose`, then inspect the returned error before retrying a write.
