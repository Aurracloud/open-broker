OpenBroker Trading Automation Harness

 Context

 OpenBroker has rigid built-in strategies (DCA, grid, MM) with hardcoded polling loops. Since the CLI is primarily used by agentic coding tools (Claude Code, OpenClaw,
 pi-mono), agents need the flexibility to write their own trading logic using OpenBroker's core client as an SDK. Inspired by pi-mono's extension system (factory function +
 event subscriptions), we're building an event-driven automation runtime.

 File Structure

 All new files under scripts/auto/:

 scripts/auto/
   types.ts       -- AutomationAPI interface, typed event payloads
   events.ts      -- Lightweight typed event bus (internal)
   loader.ts      -- Discovers and loads automation .ts files
   runtime.ts     -- AutomationRuntime: lifecycle, polling, event dispatch
   cli.ts         -- CLI entry: `openbroker auto run|list|status`

 User automations live in ~/.openbroker/automations/ as .ts files.

 Core API (types.ts)

 What agents write

 export default function(api: AutomationAPI) {
   api.on('funding_update', async ({ coin, annualized }) => {
     if (coin === 'ETH' && annualized > 0.5) {
       await api.client.marketOrder('ETH', false, 0.1);
     }
   });
 }

 AutomationAPI interface

 interface AutomationAPI {
   client: HyperliquidClient;           // Full 42-method SDK
   utils: { roundPrice, roundSize, sleep, normalizeCoin };

   on<E extends EventType>(event: E, handler): void;  // Event subscriptions
   every(intervalMs: number, handler): void;           // Scheduled tasks

   onStart(handler): void;              // Lifecycle hooks
   onStop(handler): void;
   onError(handler): void;

   state: { get, set, delete, clear };  // Persisted key-value state
   log: { info, warn, error, debug };   // Structured logger

   id: string;
   dryRun: boolean;
 }

 Event types

 ┌──────────────────┬───────────────────────────────────────────────────┬──────────────────────────────────┐
 │      Event       │                      Payload                      │             Trigger              │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ tick             │ { timestamp, pollCount }                          │ Every poll cycle                 │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ price_change     │ { coin, oldPrice, newPrice, changePct }           │ Mid price moved beyond threshold │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ funding_update   │ { coin, fundingRate, annualized, premium }        │ Every poll for subscribed coins  │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ position_opened  │ { coin, side, size, entryPrice }                  │ New position detected            │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ position_closed  │ { coin, previousSize, entryPrice }                │ Position gone                    │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ position_changed │ { coin, oldSize, newSize, entryPrice }            │ Size/leverage changed            │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ pnl_threshold    │ { coin, unrealizedPnl, changePct, positionValue } │ PnL moved beyond threshold       │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ margin_warning   │ { marginUsedPct, equity, marginUsed }             │ Margin usage above threshold     │
 ├──────────────────┼───────────────────────────────────────────────────┼──────────────────────────────────┤
 │ order_filled     │ { coin, oid, side, size, price }                  │ Open order was filled            │
 └──────────────────┴───────────────────────────────────────────────────┴──────────────────────────────────┘

 Runtime Architecture (runtime.ts)

 Polling loop (single setInterval per automation)

 Each poll cycle:
 1. Fetch getUserStateAll(), getAllMids(), getOpenOrders() (reuse client singleton)
 2. Build snapshot, compare to previous (same pattern as watcher.ts detectEvents)
 3. Dispatch matching events to registered handlers (sequentially, with try/catch per handler)
 4. tick fires every cycle regardless
 5. Check every() timers against elapsed time

 Key decisions

 - One poll loop per automation — simple, no shared pub/sub complexity
 - In-process execution — no subprocess isolation (fast feedback for agents, error isolated via try/catch)
 - Dry run — wraps client in proxy that intercepts write methods (marketOrder, limitOrder, etc.) and logs instead of executing
 - No new dependencies — Node.js built-ins only
 - Handlers run sequentially — prevents race conditions on shared state

 Lifecycle

 1. Load script via dynamic import() (tsx handles transpilation)
 2. Create AutomationAPI, call factory function (registers handlers)
 3. Call onStart hooks
 4. Start poll interval
 5. On SIGINT/stop: clear interval → call onStop hooks → flush state

 State persistence

 - ~/.openbroker/state/<automationId>.json
 - Loaded on start, written on set() (debounced)

 CLI Integration (cli.ts)

 Add to bin/cli.ts dispatch table:
 'auto': { script: 'auto/cli.ts', description: 'Run/manage trading automations' }

 Commands:
 openbroker auto run <script> [--dry] [--verbose] [--id <name>] [--poll <ms>]
 openbroker auto list                    # List scripts in ~/.openbroker/automations/
 openbroker auto status                  # Show running automation info

 auto run is a long-lived process (like existing strategies). SIGINT stops gracefully.

 Plugin Integration

 Add 3 tools to scripts/plugin/tools.ts and register in scripts/plugin/index.ts:
 - ob_auto_run — start an automation by name/path, returns automation ID
 - ob_auto_stop — stop a running automation by ID
 - ob_auto_list — list available + running automations

 Files to modify

 ┌─────────────────────────┬─────────────────────────────────────────────────┐
 │          File           │                     Change                      │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/auto/types.ts   │ New — all interfaces and event type definitions │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/auto/events.ts  │ New — typed EventBus class                      │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/auto/loader.ts  │ New — script discovery and loading              │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/auto/runtime.ts │ New — AutomationRuntime class                   │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/auto/cli.ts     │ New — CLI entry point                           │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ bin/cli.ts              │ Edit — add auto to command dispatch table       │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/plugin/tools.ts │ Edit — add ob_auto_run/stop/list tools          │
 ├─────────────────────────┼─────────────────────────────────────────────────┤
 │ scripts/plugin/index.ts │ Edit — register auto tools                      │
 └─────────────────────────┴─────────────────────────────────────────────────┘

 Existing code to reuse

 - scripts/core/client.ts — getClient() singleton, all 42 public methods
 - scripts/core/utils.ts — roundPrice, roundSize, parseArgs, sleep, normalizeCoin
 - scripts/plugin/watcher.ts — snapshot diffing pattern for buildSnapshot() and detectEvents()
 - scripts/core/config.ts — loadConfig() for env var resolution

 Migration

 - Existing strategies in scripts/strategies/ remain untouched
 - Automation harness is purely additive (new scripts/auto/ directory)
 - Strategies can optionally be rewritten as automations later

 Implementation order

 1. types.ts — API contract first
 2. events.ts — event bus
 3. loader.ts — script loading
 4. runtime.ts — main runtime (depends on above + core modules)
 5. cli.ts — CLI integration
 6. bin/cli.ts — add dispatch entry
 7. scripts/plugin/tools.ts + index.ts — plugin tools

 Verification

 1. Create a test automation at ~/.openbroker/automations/test-tick.ts that logs every tick
 2. Run openbroker auto run test-tick --dry --verbose — verify it polls and logs
 3. Create a price-change automation, verify events fire when mid prices move
 4. Test openbroker auto list shows available scripts
 5. Test SIGINT graceful shutdown calls onStop hooks
 6. Test error isolation: handler that throws doesn't crash the loop

