---
name: paseo-integration-build
description: Build and optionally install Paseo from integration/dev with reproducible dependency, packaging, systemd, and runtime verification. Use when the user asks to build, package, install, run, or roll back the integration/dev checkout.
user-invocable: true
---

# Paseo integration build

Use this skill for the optional build and install stage after the
`integration/dev` consume gates. Read these first:

- `docs/fork-integration.md` for branch and consume policy.
- `docs/development.md` for package build targets and daemon conventions.
- `.paseo-integration/manifest.json` for the current pins.

This skill does not merge feature heads, update the manifest, or open upstream
pull requests. Keep those operations in
`.agents/skills/paseo-integration-maintenance/SKILL.md`.

## Safety rules

- A build does not authorize an install. Never restart the production daemon
  on port `6767` unless the user explicitly asks for the install or replacement.
- Default to an isolated `PASEO_HOME` and a non-production port for runtime
  checks. Preserve the user's existing `~/.paseo` data.
- Never use `git reset --hard`, `git checkout`, force-push, auto-stash, or a
  recursive delete to make the build pass.
- Keep `package-lock.json` unchanged unless the user explicitly requests a
  dependency update. Inspect any lockfile diff before committing.
- Use a Paseo watchdog job for dependency installation, builds, packaging, and
  other bounded commands that can outlive the current turn. When a watchdog
  reports a worker error, inspect its stdout and stderr artifacts before
  deciding whether a retry is needed.
- Do not kill a daemon PID to replace an install. A systemd service with
  `Restart=always` will relaunch the old checkout. Inspect and update the
  service source first.

## Preflight

Run from the repository root and stop on a dirty tree:

```bash
git status --short --branch
git branch --show-current
node .agents/skills/paseo-integration-maintenance/scripts/integration.mjs status --json
node .agents/skills/paseo-integration-maintenance/scripts/integration.mjs verify-manifest --json
node -p "require('./packages/server/package.json').version"
node --version
npm --version
```

The current branch must be `integration/dev`, the manifest must verify, and
the worktree must be clean before a mutating build or install step. Record the
current commit and installed artifact before an install so rollback has a
known-good target.

## Dependencies

Use the lockfile-driven install for a cold checkout:

```bash
npm ci
```

`npm ci` runs the repository postinstall patches and hook setup. If an
existing checkout needs workspace dependency repair instead, use the repository
workspace command:

```bash
npm install --workspaces --include-workspace-root
```

After either command, inspect `git status --short -- package-lock.json` and
stop if npm changed the lockfile unexpectedly. Deprecation warnings do not
make the install fail; use the command exit code and the postinstall result.

## Build order

Choose the smallest target that satisfies the request.

Server, daemon, and CLI changes:

```bash
npm run build:server
npm run typecheck:server
```

The server build owns the cross-package declaration chain. Build it before
diagnosing callback or inferred-type errors in dependent packages.

Desktop packaging:

```bash
npm run build:desktop
```

The desktop target rebuilds app dependencies, exports the Electron web app,
rebuilds the server stack, and packages Electron. On Linux the checked-in
configuration requests `AppImage`, `deb`, `rpm`, and `tar.gz`. If `rpmbuild`
is not installed, the default command can produce the other artifacts and
then exit non-zero at the RPM target. Treat that as a missing packaging tool,
not as evidence that the JavaScript build failed. Either install the RPM
toolchain, or rerun the packaging phase with only the available targets after
the dependency and server build phases have passed:

```bash
npm run build:app-deps:clean
(cd packages/app && PASEO_WEB_PLATFORM=electron npx expo export --platform web)
npm run build:server:clean
npm run build:main --workspace=@getpaseo/desktop
(cd packages/desktop && npm exec -- electron-builder --config electron-builder.yml --linux AppImage deb tar.gz)
```

Do not hide a missing target by ignoring the exit code. Report which artifacts
were produced and which target was unavailable.

After a desktop build, inspect `packages/desktop/release/` and verify the
unpacked app or selected package exists. Run the desktop typecheck as well:

```bash
npm run typecheck --workspace=@getpaseo/desktop
```

For changes that affect formatting or source quality, finish with the
repository scripts:

```bash
npm run format
npm run format:check
npm run lint
```

Do not run the full test suite locally. Run only the changed test file with
`npx vitest run <file> --bail=1`; use CI for broad verification.

## Isolated runtime verification

Before touching the production daemon, run the built server with an isolated
home and port when the change permits it. Use a disposable, explicitly named
home rather than `~/.paseo`:

```bash
PASEO_HOME=/tmp/paseo-integration-dev-home PASEO_LISTEN=127.0.0.1:6769 node packages/cli/dist/index.js daemon start --home /tmp/paseo-integration-dev-home --listen 127.0.0.1:6769
```

Verify the JSON status reports the package version built from this checkout,
the expected port, and a reachable daemon. Inspect the supervisor and worker
cwd through `/proc` if there is any doubt that another worktree supplied the
runtime.

## Production install on 6767

Only perform this section after explicit user authorization.

First inspect the service that owns the port:

```bash
systemctl --user cat paseo-daemon.service
systemctl --user show paseo-daemon.service -p WorkingDirectory -p ExecStart -p Environment -p Restart -p MainPID
```

The service `WorkingDirectory` must be the intended `integration/dev`
checkout. Preserve its existing `PASEO_HOME`, `PASEO_LISTEN`, relay, and other
environment settings. If it points at a sibling feature worktree, update the
service with a user-systemd drop-in or the service's managed source before
restarting it. Do not stop only the worker or supervisor; `Restart=always`
will bring the old worktree back.

Reload after the service source changes:

```bash
systemctl --user daemon-reload
```

If the current agent is itself running inside `paseo-daemon.service`, a normal
blocking restart can terminate the agent before it verifies the result. Queue
the restart in a separate user-systemd transient unit so the restart survives
the old cgroup going away:

```bash
systemd-run --user --unit=paseo-integration-switch --collect --service-type=oneshot /bin/bash -lc 'systemctl --user restart paseo-daemon.service'
```

After the service is back, verify all of these:

```bash
systemctl --user status paseo-daemon.service --no-pager -l
ss -ltnp | rg ':6767\b'
env PASEO_HOME=~/.paseo node packages/cli/dist/index.js daemon status --home ~/.paseo --json
tail -n 200 ~/.paseo/daemon.log | rg 'daemonVersion|Server listening|relay_control_connected|relay_data_connected'
```

The daemon version must match the current checkout, the supervisor and worker
must have the intended cwd, port `6767` must be listening, and relay control
and data connections must appear when relay is enabled. If the UI still shows
the previous version, refresh or reconnect it after the daemon handshake; do
not rebuild a second time before checking the server status.

## Rollback record

Before an authorized install, record:

- `git rev-parse HEAD` and the branch name;
- the service `WorkingDirectory` and `ExecStart`;
- the installed artifact path and version;
- the daemon status JSON and log path.

If the install fails, restore the recorded artifact and service source, run
`systemctl --user daemon-reload`, and restart through the same service-aware
path. Do not roll back by checking out a moving ref or rewriting
`integration/dev`.

## Completion checklist

Report the exact branch and commit, dependency result, build target and
artifacts, typecheck/lint/format results, runtime version, service cwd, port,
relay state, and any unavailable packaging target. A build is not complete
when only the command has exited; the produced artifact and the running
daemon must be verified separately.
