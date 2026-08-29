---
name: paseo-integration-maintenance
description: Maintain Paseo's long-lived fork integration branch and upstreamable feature work. Use when the user mentions integration/dev, fork integration, official release updates, owned or third-party PR integration, custom build/install/rollback, upstreamed-feature reconciliation, creating or updating upstreamable Paseo features, or "/paseo-integration-maintenance".
user-invocable: true
---

# Paseo integration maintenance

Read `docs/fork-integration.md` before any work. That doc owns policy. Do not
restate it here. Read `.paseo-integration/manifest.json` for the current
pins.

Supporting CLI (repo-relative):
`.agents/skills/paseo-integration-maintenance/scripts/integration.mjs`

The script resolves the repo from its own location, not the caller cwd. Run
this read-only sequence from the repo root. Add `--json` to any command.

```bash
node .agents/skills/paseo-integration-maintenance/scripts/integration.mjs status
node .agents/skills/paseo-integration-maintenance/scripts/integration.mjs verify-manifest
node .agents/skills/paseo-integration-maintenance/scripts/integration.mjs preflight-update --tag <tag>
node .agents/skills/paseo-integration-maintenance/scripts/integration.mjs preflight-integrate --ref <ref-or-sha> [--kind feature|pull-request]
```

Use `preflight-update` for an official stable tag and `preflight-integrate`
for a feature or pull-request SHA. `build`, `install`, and `rollback` are not
available. Do not invent them.

## Triggers

Apply this skill when the user asks to:

- create or update an upstreamable Paseo feature (`feat/*`, owned PR)
- maintain `integration/dev`
- consume an official stable release into the integration branch
- integrate a third-party pull request
- reconcile an upstreamed, squashed, or rebased feature
- prepare or discuss a custom build, install, or rollback

## Orchestration

Decide the lane first.

**Upstream feature work** happens on the feature branch and targets
`getpaseo/paseo`. Keep `integration/dev` out of that history. Open or update
the upstream pull request from the feature branch.

**Integration maintenance** happens on `integration/dev`. Consume an exact
SHA, update the matching manifest pin, then run the verify gates in the doc.
Do not merge `integration/dev` into `feat/*`. Do not open an upstream pull
request from `integration/dev`.

Match the user request to one doc operation: official release update, owned
feature update, external PR integration, or upstreamed reconciliation.

Stop after verify unless a later slice explicitly authorizes build or
install.
