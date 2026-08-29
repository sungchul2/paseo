# Fork integration

`integration/dev` is a long-lived consume branch on this fork. It is for early
integration QA and, later, custom build and install. Feature work still targets
upstream [`getpaseo/paseo`](https://github.com/getpaseo/paseo) on its own
branches.

This doc owns the policy. Current pins live in
[`.paseo-integration/manifest.json`](../.paseo-integration/manifest.json). The
portable skill
[`.agents/skills/paseo-integration-maintenance`](../.agents/skills/paseo-integration-maintenance/SKILL.md)
orchestrates the work and points here.

Do not merge `integration/dev` into any `feat/*` branch. Do not open an
upstream pull request from `integration/dev`.

## Branch roles

| Branch                                                         | Role                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Official `main` and stable tags on `origin` (`getpaseo/paseo`) | Upstream source. Releases and review land here.                                                                         |
| Owned `feat/*` (this fork, for example `sungchul2`)            | Upstreamable feature work. The pull request source.                                                                     |
| External feature branches on `getpaseo/paseo`                  | Third-party pull requests you may consume.                                                                              |
| `integration/dev`                                              | Consume pinned feature heads and official stables for integration QA and later custom builds. Never an upstream source. |

Remotes for this checkout: `origin` is `https://github.com/getpaseo/paseo.git`;
`sungchul2` is `https://github.com/sungchul2/paseo.git`.

## Stable baseline vs effective upstream ceiling

The official **stable baseline** is the dereferenced official stable tag that
started this branch or that the last official-release update moved it to. This
branch began at `v0.6.1`, commit
`20d7efc46a316f5a274b9943a5c43b0322269825`.

The **effective upstream ceiling** is the newest first-parent commit of official
`main` that is already an ancestor of `integration/dev`. Feature heads often
include unreleased `main` after the baseline. A later official `main` tip is not
in the tree until you consume it.

Record both in the manifest. Do not describe the tree as "pure" baseline when
the ceiling is ahead. Do not treat a ceiling advance as an official release
update. Do not treat `origin/main` tip as the ceiling unless that tip is
already an ancestor.

## Dual feature lifecycle

Every feature has two lanes. Keep them separate.

1. **Upstream lane.** Implement and review on the feature branch. Open or
   update the pull request against `getpaseo/paseo` from that branch.
2. **Consume lane.** Merge the feature's exact head commit into
   `integration/dev`. Pin that SHA in the manifest. Use this branch only to
   integrate, QA, and later build.

Develop the feature on the feature branch. If consume-lane QA finds a product
bug, fix it on the feature branch, then consume the new head. Integration-only
resolutions stay on `integration/dev` and never go back onto `feat/*`.

## Official release update

Use this when a newer official **stable** tag should become the baseline.

1. Stay on `integration/dev` with a clean tree.
2. Resolve the annotated tag to its commit. Record that commit; do not pin the
   tag object.
3. Compare the proposed commit to the manifest baseline. Confirm which pinned
   feature heads remain ancestors.
4. Merge that exact commit into `integration/dev`.
5. Write the new tag and commit as `officialStableBaseline`. The ceiling
   becomes at least that commit. Raise the ceiling further only if the merge
   brought a newer official-`main` ancestor.
6. Run the exact-SHA gates. Stop. Build and install are later stages.

`docs/release.md` owns how official releases are cut. This doc owns only how
`integration/dev` consumes a published stable. Do not use a beta tag as the
stable baseline. Do not merge `origin/main` to "catch up" and then call that a
release update.

## Owned feature update

Use this for a feature you own (for example pull request #3974).

1. Update the feature branch against official `main` or the stable the
   upstream pull request targets. Keep `integration/dev` out of that history.
2. Push and update the upstream pull request from the feature branch.
3. On `integration/dev`, merge the feature head by exact SHA.
4. Pin `owner`, `repo`, `ref`, `head`, `role: "owned"`, PR URL, and open
   state in the manifest.
5. Run the exact-SHA gates, including semantic review.

If the remote feature branch has moved past the pinned head, consume the new
head only after you intend that update. Do not silently follow a moving ref.

## External PR integration

Use this for a third-party pull request (for example #3588).

1. Resolve the pull request head to an exact SHA you have locally.
2. Merge that SHA into `integration/dev`. Do not merge a moving branch name
   without recording the resulting commit.
3. Pin `role: "external"` plus owner, repo, ref, head, URL, and open state.
4. Run the exact-SHA gates, including semantic review.

Watch the upstream pull request. When it merges, closes, or rebases, run
reconciliation. Do not keep consuming a dead head.

## Upstreamed reconciliation

Upstream often squash-merges or rebases. The pinned feature head then stops
being a useful ancestor of official `main` even though the work landed.

1. Find the upstream commit that replaced the feature (squash commit, rebased
   head, or merge commit on official `main`).
2. Confirm it is the intended replacement. SHA identity is not required;
   equivalent landed work is.
3. On `integration/dev`, merge that upstream commit if it is not already an
   ancestor, then drop any consume that exists only to carry the old head.
4. Update the manifest: new head or mark the feature upstreamed and remove
   the old pin. Advance the ceiling if official `main` in the tree moved
   forward.
5. Run the exact-SHA gates.

A rebased feature branch needs a new pinned head. Merge the new head; do not
rewrite `integration/dev` history to pretend the old SHA is still the source.
Never merge `integration/dev` into the rebased feature branch to "recover"
commits.

## Semantic conflicts

Treat consume as incomplete until semantic review passes, even when git
reports no textual conflict.

After every merge, inspect overlapping product surfaces: protocol messages,
persistence JSON, agent lifecycle, and UI contracts. [protocol-compatibility.md](protocol-compatibility.md)
and [data-model.md](data-model.md) own those contracts.

- Feature-owned conflicts: fix on the feature branch, then consume the new
  head so the upstream pull request stays correct.
- Consume-only conflicts (two features, or a feature against a baseline the
  upstream PR does not have): resolve on `integration/dev`. Leave that
  resolution off `feat/*`.
- Do not force, stash, reset, or rebase `integration/dev` to hide a conflict.
- Re-run exact-SHA gates after the resolution commit.

## Exact-SHA gates

Every consume, release update, and reconciliation records exact commits. Refs
and PR numbers are labels. Comparisons use full SHAs.

Required gates, in order:

1. **Exact-SHA verify.** `HEAD` is `integration/dev`. The manifest parses and matches
   this schema. `officialStableBaseline.commit` is an ancestor of `HEAD`.
   Every still-consumed feature `head` is an ancestor of `HEAD`.
   `effectiveUpstreamCeiling.remote` is `origin` and `ref` is `main`.
   `effectiveUpstreamCeiling.commit` is the newest first-parent commit of
   `origin/main` that is already an ancestor of `HEAD`. Official origin must
   be the getpaseo/paseo remote. Fail if `origin/main` is missing or no such
   ancestor exists.
2. **Build.** Future stage. Do not run a package build as part of a consume.
3. **Install.** Future stage. A later custom install must not restart the
   daemon on port 6767.
4. **Rollback.** Future stage. Record the last known-good `integration/dev`
   commit and installed artifact before a later install; restore those, not
   an unpinned ref.

Fail closed on a dirty tree for any mutating step. Do not auto-stash, reset,
rebase, or force-push. Build, install, and rollback commands do not exist
yet; do not invent them.

## Manifest

[`.paseo-integration/manifest.json`](../.paseo-integration/manifest.json) is
the pin file. It holds `schemaVersion`, the integration branch, the official
stable baseline tag and dereferenced commit, the effective upstream ceiling
(`origin`/`main` and that exact commit), each consumed feature record, and the
required verification gates.

Do not add timestamps that change on read. Update the file when a pin
changes.

## Completion

| Work                        | Done when                                                                                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream feature            | The pull request against `getpaseo/paseo` comes from the feature branch, not from `integration/dev`.                                                      |
| Consume (owned or external) | The exact head is merged, the manifest pin matches, verify gates pass, and semantic review is done. Build and install are not part of consume completion. |
| Official release update     | The new stable tag and commit are the baseline, the ceiling is consistent, leftover feature pins still account for themselves, and verify gates pass.     |
| Reconciliation              | The old head is no longer required, the replacement is recorded, and the tree does not carry a duplicate conflicting copy.                                |
| This documentation slice    | Policy, skill, adapter symlink, and manifest exist. No build or install.                                                                                  |
