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

## Out of scope for this slice

Do not restart or replace the live daemon. Do not migrate existing watchdog jobs. Plugin adapter and guarded rollout are the next parent-owned slice.
