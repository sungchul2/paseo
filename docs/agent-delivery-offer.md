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

- `deferred.busy`: in-flight turn; retry when idle. No interrupt.
- `deferred.pending_permission`: human permission prompt is open; do not clear it.
- `duplicate`: canonical `user_message.clientMessageId` already exists, including crash windows after accept.
- `rejected`: missing/archived/closed agent, fingerprint conflict (`agent_delivery_key_conflict`), or send failure after the durable `accepted` receipt

Admission is per-agent mutexed. The journal writes `accepted` before send and `completed` after send. A crash between those states retries send only after the live busy/permission checks pass again.

Send flags: `activeTurnBehavior: "steer"`, `replaceRunning: false`, `clearPendingPermissions: false`, `unarchive: false`.

Plugin RPC and core watchdog notifier share one `AgentDeliveryOfferer` instance created in bootstrap.

## Out of scope for this slice

Do not restart or replace the live daemon. Do not migrate existing watchdog jobs. Plugin adapter and guarded rollout are the next parent-owned slice.
