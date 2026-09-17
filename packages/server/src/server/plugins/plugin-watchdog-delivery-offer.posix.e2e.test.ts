/**
 * Isolated watchdog job E2E against this worktree's in-process daemon + the
 * paseo-watchdog plugin checkout. Uses the synthetic mock provider, not live
 * agent credentials. Does not restart the live daemon on 127.0.0.1:6767.
 *
 * Required setup from this worktree root:
 *
 *   npx tsc -p packages/protocol/tsconfig.json --incremental false
 *   npx tsc -p packages/client/tsconfig.json --incremental false
 *
 * Then from packages/server, with the plugin checkout path (d1b675 or later
 * with delivery-offer adapter). Do not symlink live integration-dev deps:
 *
 *   PASEO_WATCHDOG_PLUGIN_ROOT=/abs/path/to/paseo-watchdog \
 *     npm exec --no -- vitest run src/server/plugins/plugin-watchdog-delivery-offer.posix.e2e.test.ts --maxWorkers=1
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { requireWorktreeClientDist } from "./require-worktree-client-dist.js";

const LIVE_LISTEN_PORT = 6767;
const WAKE_PREFIX = "paseo-watchdog-wake:";
const PLUGIN_ID = "paseo-watchdog";

interface WatchdogJob {
  id: string;
  status: string;
  deliveryStatus: string;
  result: { exitCode: number | null } | null;
}

interface InspectResult {
  job: WatchdogJob | null;
  error: string | null;
}

interface StartResult {
  job: WatchdogJob | null;
  error: string | null;
}

const roots: string[] = [];
const envSnapshot = {
  PASEO_HOME: process.env.PASEO_HOME,
  PASEO_WATCHDOG_PLUGIN_ROOT: process.env.PASEO_WATCHDOG_PLUGIN_ROOT,
  PASEO_WATCHDOG_ALLOW_UNSAFE_WAKE: process.env.PASEO_WATCHDOG_ALLOW_UNSAFE_WAKE,
};

afterEach(async () => {
  restoreEnv();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function restoreEnv(): void {
  restoreEnvKey("PASEO_HOME", envSnapshot.PASEO_HOME);
  restoreEnvKey("PASEO_WATCHDOG_PLUGIN_ROOT", envSnapshot.PASEO_WATCHDOG_PLUGIN_ROOT);
  restoreEnvKey("PASEO_WATCHDOG_ALLOW_UNSAFE_WAKE", envSnapshot.PASEO_WATCHDOG_ALLOW_UNSAFE_WAKE);
}

function restoreEnvKey(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function resolveWatchdogPluginRoot(): string {
  const fromEnv = process.env.PASEO_WATCHDOG_PLUGIN_ROOT?.trim();
  if (!fromEnv) {
    throw new Error(
      [
        "Set PASEO_WATCHDOG_PLUGIN_ROOT to the paseo-watchdog checkout (adapter at d1b675).",
        "Example:",
        "  PASEO_WATCHDOG_PLUGIN_ROOT=/home/sungchul/workspace/src/side_projects/paseo-watchdog \\",
        "    npm exec --no -- vitest run src/server/plugins/plugin-watchdog-delivery-offer.posix.e2e.test.ts --maxWorkers=1",
      ].join("\n"),
    );
  }
  const pluginRoot = path.resolve(fromEnv);
  const manifest = path.join(pluginRoot, "paseo-plugin.json");
  const worker = path.join(pluginRoot, "server", "worker-entrypoint.mjs");
  const adapter = path.join(pluginRoot, "shared", "delivery-offer.ts");
  if (!existsSync(manifest) || !existsSync(worker) || !existsSync(adapter)) {
    throw new Error(
      `PASEO_WATCHDOG_PLUGIN_ROOT=${pluginRoot} is not a paseo-watchdog checkout with worker + delivery-offer adapter`,
    );
  }
  return pluginRoot;
}

function wakeUserMessages(timeline: {
  entries: Array<{ item: { type?: string; clientMessageId?: string; text?: string } }>;
}): Array<{ clientMessageId: string; text: string }> {
  return timeline.entries
    .map((entry) => entry.item)
    .filter(
      (item): item is { type: "user_message"; clientMessageId: string; text: string } =>
        item.type === "user_message" &&
        typeof item.clientMessageId === "string" &&
        item.clientMessageId.startsWith(WAKE_PREFIX) &&
        typeof item.text === "string",
    )
    .map((item) => ({ clientMessageId: item.clientMessageId, text: item.text }));
}

async function inspectJob(client: DaemonClient, jobId: string): Promise<InspectResult> {
  return (await client.invokePluginRpc(PLUGIN_ID, "watchdog.inspect", { jobId })) as InspectResult;
}

async function startJob(
  client: DaemonClient,
  input: {
    name: string;
    agentId: string;
    workspaceId: string;
    cwd: string;
  },
): Promise<WatchdogJob> {
  const started = (await client.invokePluginRpc(PLUGIN_ID, "watchdog.start", {
    name: input.name,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    command: "/bin/echo",
    args: ["watchdog-ok"],
    timeoutMs: 15_000,
  })) as StartResult;
  if (started.error || !started.job) {
    throw new Error(started.error ?? "watchdog.start returned no job");
  }
  return started.job;
}

async function waitForJob(
  client: DaemonClient,
  jobId: string,
  predicate: (job: WatchdogJob) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<WatchdogJob> {
  const deadline = Date.now() + timeoutMs;
  let last: WatchdogJob | null = null;
  while (Date.now() < deadline) {
    const inspect = await inspectJob(client, jobId);
    if (inspect.error) throw new Error(`${label}: ${inspect.error}`);
    last = inspect.job;
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

test("isolated watchdog job offers once, defers busy/permission, never send-falls-back", async () => {
  requireWorktreeClientDist();
  const pluginRoot = resolveWatchdogPluginRoot();
  const cwd = await mkdtemp(path.join(tmpdir(), "paseo-watchdog-e2e-cwd-"));
  roots.push(cwd);

  const daemon = await createTestPaseoDaemon({
    isDev: true,
    pluginsEnabled: true,
    mcpEnabled: false,
    daemonVersion: "0.8.0",
    agentClients: { mock: new MockLoadTestAgentClient() },
  });
  expect(daemon.port, "must not bind the live daemon port").not.toBe(LIVE_LISTEN_PORT);
  expect(daemon.paseoHome).not.toBe(path.join(process.env.HOME ?? "", ".paseo"));

  process.env.PASEO_HOME = daemon.paseoHome;
  process.env.PASEO_WATCHDOG_PLUGIN_ROOT = pluginRoot;
  delete process.env.PASEO_WATCHDOG_ALLOW_UNSAFE_WAKE;

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.8.0",
  });

  try {
    await client.connect();
    const installed = await client.installDirectoryPlugin(pluginRoot, PLUGIN_ID);
    expect(installed).toMatchObject({ id: PLUGIN_ID, status: "running" });

    const workspace = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
      title: "Watchdog delivery offer e2e",
    });
    const workspaceId = workspace.workspace?.id;
    if (!workspaceId) throw new Error(workspace.error ?? "workspace create failed");

    const agent = await client.createAgent({
      provider: "mock",
      cwd,
      workspaceId,
      model: "e2e-fast-stream",
      title: "Watchdog mock",
    });
    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 15_000);

    const idleJob = await startJob(client, {
      name: "idle-complete",
      agentId: agent.id,
      workspaceId,
      cwd,
    });
    const idleDelivered = await waitForJob(
      client,
      idleJob.id,
      (job) => job.status === "completed" && job.deliveryStatus === "delivered",
      "idle delivery",
    );
    expect(idleDelivered.result?.exitCode).toBe(0);
    await client.waitForFinish(agent.id, 15_000);

    const afterIdle = wakeUserMessages(
      await client.fetchAgentTimeline(agent.id, { projection: "canonical", direction: "tail" }),
    );
    expect(afterIdle).toHaveLength(1);
    expect(afterIdle[0]?.clientMessageId).toBe(`${WAKE_PREFIX}${idleJob.id}`);
    expect(afterIdle[0]?.text).toContain("offerWhenIdle");
    expect(afterIdle[0]?.text).toContain("Do not rerun");
    expect(afterIdle[0]?.text).not.toContain("unsafe_wake");

    await client.sendMessage(agent.id, "keep the mock turn busy");
    const busyJob = await startJob(client, {
      name: "busy-complete",
      agentId: agent.id,
      workspaceId,
      cwd,
    });
    const busyPending = await waitForJob(
      client,
      busyJob.id,
      (job) => job.status === "completed" && job.deliveryStatus === "pending",
      "busy deferral",
      10_000,
    );
    expect(busyPending.deliveryStatus).toBe("pending");
    await client.waitForFinish(agent.id, 15_000);
    await waitForJob(client, busyJob.id, (job) => job.deliveryStatus === "delivered", "busy retry");
    const afterBusy = wakeUserMessages(
      await client.fetchAgentTimeline(agent.id, { projection: "canonical", direction: "tail" }),
    );
    expect(afterBusy.map((item) => item.clientMessageId).sort()).toEqual(
      [`${WAKE_PREFIX}${busyJob.id}`, `${WAKE_PREFIX}${idleJob.id}`].sort(),
    );

    await client.sendMessage(agent.id, "Emit synthetic plan approval.");
    const parked = await client.waitForFinish(agent.id, 15_000);
    expect(parked.status).toBe("permission");
    const permissionAgent = await client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.pendingPermissions.length > 0,
      10_000,
    );
    const permission = permissionAgent.pendingPermissions[0];
    if (!permission) throw new Error("expected synthetic plan approval");

    const permissionJob = await startJob(client, {
      name: "permission-complete",
      agentId: agent.id,
      workspaceId,
      cwd,
    });
    await waitForJob(
      client,
      permissionJob.id,
      (job) => job.status === "completed" && job.deliveryStatus === "pending",
      "permission deferral",
    );
    const stillParked = await client.fetchAgent(agent.id);
    expect(stillParked?.agent.pendingPermissions.map((item) => item.id)).toContain(permission.id);
    const duringPermission = wakeUserMessages(
      await client.fetchAgentTimeline(agent.id, { projection: "canonical", direction: "tail" }),
    );
    expect(
      duringPermission.some((item) => item.clientMessageId === `${WAKE_PREFIX}${permissionJob.id}`),
    ).toBe(false);

    await client.respondToPermission(agent.id, permission.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    await client.waitForFinish(agent.id, 15_000);
    await waitForJob(
      client,
      permissionJob.id,
      (job) => job.deliveryStatus === "delivered",
      "permission retry",
    );
    const afterPermission = wakeUserMessages(
      await client.fetchAgentTimeline(agent.id, { projection: "canonical", direction: "tail" }),
    );
    expect(afterPermission).toHaveLength(3);
    expect(afterPermission.map((item) => item.clientMessageId).sort()).toEqual(
      [
        `${WAKE_PREFIX}${busyJob.id}`,
        `${WAKE_PREFIX}${idleJob.id}`,
        `${WAKE_PREFIX}${permissionJob.id}`,
      ].sort(),
    );
    for (const wake of afterPermission) {
      expect(wake.text).toContain("offerWhenIdle");
      expect(wake.text).toContain("Do not rerun");
    }

    const reloaded = await client.reloadPlugin(PLUGIN_ID);
    expect(reloaded.status).toBe("running");
    await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle", 15_000);
    const reloadJob = await startJob(client, {
      name: "reload-complete",
      agentId: agent.id,
      workspaceId,
      cwd,
    });
    await waitForJob(
      client,
      reloadJob.id,
      (job) => job.status === "completed" && job.deliveryStatus === "delivered",
      "reload delivery",
    );
    const afterReload = wakeUserMessages(
      await client.fetchAgentTimeline(agent.id, { projection: "canonical", direction: "tail" }),
    );
    expect(afterReload).toHaveLength(4);
    expect(
      afterReload.some((item) => item.clientMessageId === `${WAKE_PREFIX}${reloadJob.id}`),
    ).toBe(true);
  } catch (error) {
    const logs = await client.getPluginLogs(PLUGIN_ID).catch(() => []);
    const rendered = logs.map((entry) => `[${entry.stream}] ${entry.message}`).join("\n");
    throw new Error(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\nplugin logs:\n${rendered}`,
      { cause: error },
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    restoreEnv();
  }
}, 180_000);
