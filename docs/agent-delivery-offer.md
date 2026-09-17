# Agent delivery offer

Prerequisite public API for safe automatic resume. Consume-lineage from `integration/dev` (`287149eb7`). Protocol package remains `0.8.0`; the capability is the `server_info` feature flag, not a package bump.

## Capability contract

- Feature: `features.agentDeliveryOffer`
- COMPAT: added in v0.8.x; remove the gate after 2027-03-17
- RPC: `agent.delivery.offer.request` / `agent.delivery.offer.response`
- Client: `DaemonClient.offerAgentDelivery` and `PaseoAgentHandle.offerWhenIdle`
- Auth: `workspace.write` or `hub.execute`
- `send()` is unchanged: it still interrupts and clears pending permissions

## Offer semantics

Statuses: `accepted` | `deferred` | `duplicate` | `rejected`

- `deferred.busy`: in-flight turn at the shared AgentManager admission boundary. No interrupt, steer, or replace.
- `deferred.pending_permission`: human permission prompt is open; do not clear it.
- `duplicate`: canonical `user_message.clientMessageId` already exists, including crash windows after that persist.
- `rejected`: missing/archived/closed agent, fingerprint conflict (`agent_delivery_key_conflict`), or dispatch failure

Idle admission is `AgentManager.tryStartIdleTurn`: the final idle/permission checks and `createPendingRun` run in one synchronous section. Offer-specific mutexes are not the safety boundary. Callers that lose the race are deferred; they never steer or replace.

Inspect rejects archived agents from storage **before** `ensureAgentLoaded`, so archived history is not resumed as a read side effect.

## Receipts

- `recorded`: fingerprint claimed; dispatch has not been admitted
- `accepted`: `tryStartIdleTurn` actually reserved the run
- `completed`: canonical `user_message.clientMessageId` is on the timeline

A pre-admit journal write may await. After that await, send still goes through `admitIdleForegroundTurn` / `tryStartIdleTurn` and must defer instead of interrupting.

## Reproducing plugin IPC, typecheck, and isolated watchdog E2E

`plugin-process` loads `@getpaseo/client` from this worktree's `packages/client/dist/index.js` (package `default` export), not TypeScript source. A source-only tree fails with `Plugin <id> exited during initialization`. After the harness fix that error includes captured plugin stderr.

This worktree path is nested under live `integration-dev/.worktrees/`, so missing workspace `dist` type entrypoints can resolve through the **parent** `node_modules` and mix live vs worktree `DaemonClient` types. Do **not** delete client dist to make typecheck pass. Do **not** symlink `packages/*/node_modules` onto live integration-dev.

If task-owned workspace links point at live packages, replace **only those symlink inodes** (never `rm -rf` the live target), then:

```
npm install --ignore-scripts --no-audit --no-fund --prefer-offline
```

From this worktree root, build the local type/runtime entrypoints (protocol + client are enough for IPC; plugin/highlight/relay/server dists are required for `npm run typecheck` with client dist present):

```
npx tsc -p packages/protocol/tsconfig.json --incremental false
npx tsc -p packages/client/tsconfig.json --incremental false
npx tsc -p packages/plugin/tsconfig.json --incremental false
npx tsc -p packages/highlight/tsconfig.json --incremental false
npx tsc -p packages/relay/tsconfig.json --incremental false
npx tsc -p packages/server/tsconfig.server.json --incremental false
cd packages/server
npm exec --no -- vitest run src/server/plugins/plugin-delivery-offer-ipc.posix.test.ts --maxWorkers=1
```

Parent-verified sequence for IPC is still `npm exec --no -- tsc` on protocol then client. Keep those dists; add the extra packages only when typecheck/CLI types are required on the same artifact.

No extra env is required for the IPC test. Plugin children strip inherited `PASEO_AGENT_*`, `PASEO_HOST`/`PASEO_LISTEN`/`PASEO_PASSWORD`, hub keys, and `PASEO_WATCHDOG_ALLOW_UNSAFE_WAKE`.

Isolated watchdog E2E (in-process test daemon, mock provider, real plugin process + detached `/bin/echo`; not the live `127.0.0.1:6767` daemon):

```
PASEO_WATCHDOG_PLUGIN_ROOT=/abs/path/to/paseo-watchdog \
  npm exec --no -- vitest run src/server/plugins/plugin-watchdog-delivery-offer.posix.e2e.test.ts --maxWorkers=1
```

Use plugin commit at or after the inventory/migration slice on `main`, with the capability-gated adapter. The E2E sets `PASEO_HOME` to the test daemon's temp home for the plugin child; it does not copy `~/.paseo` credentials.

## Out of scope for live operations

Do not restart or replace the live daemon in this slice. Do not run live import (`PASEO_WATCHDOG_ALLOW_LIVE_IMPORT`). Plugin inventory/migration CLI is documented in the plugin repo `docs/MIGRATION.md`. Running/cancelling/pending-core jobs stay core-owned; unified UI lists them as shadows only.
