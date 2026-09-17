import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { sendPromptToAgent, startAgentRun } from "./agent-prompt.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  AgentDeliveryOfferer,
  createAgentManagerDeliveryGate,
  type DeliveryOfferReceipt,
} from "./delivery-offer.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  SteerActiveTurnOptions,
  SteerResult,
} from "./agent-sdk-types.js";

const logger = createTestLogger();

const TEST_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function drainAsyncGenerator<T>(generator: AsyncGenerator<T>): Promise<void> {
  for await (const _ of generator) {
    // Drain provider events while AgentManager subscribers observe them.
  }
}

const PERMISSION_REQUEST = {
  id: "perm-offer-1",
  provider: "codex" as const,
  kind: "tool" as const,
  name: "Read file",
};

class HeldTurnSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  interruptCount = 0;
  steerCount = 0;
  startCount = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly completed = deferred<void>();

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<{ sessionId: string; finalText: string; timeline: [] }> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = `held-turn-${++this.startCount}`;
    queueMicrotask(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
    });
    void (async () => {
      await this.completed.promise;
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    })();
    return { turnId };
  }

  async steerActiveTurn(
    _prompt: AgentPromptInput,
    _options: SteerActiveTurnOptions,
  ): Promise<SteerResult> {
    this.steerCount += 1;
    return { status: "accepted" };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      try {
        callback(event);
      } catch {
        // error isolation per design
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      turnId: `held-turn-${this.startCount}`,
    });
  }

  async close(): Promise<void> {}

  complete(): void {
    this.completed.resolve();
  }
}

class RecordingClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly sessions: HeldTurnSession[] = [];
  resumeCount = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const session = new HeldTurnSession(config);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeCount += 1;
    const session = new HeldTurnSession({
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
    });
    this.sessions.push(session);
    return session;
  }
}

class HeldLoadManager extends AgentManager {
  holdLoad = false;
  readonly loadStarted = deferred<void>();
  readonly loadContinue = deferred<void>();

  override async waitForAgentClose(agentId: string): Promise<void> {
    await super.waitForAgentClose(agentId);
    if (this.holdLoad) {
      this.loadStarted.resolve();
      await this.loadContinue.promise;
    }
  }
}

function memoryJournal() {
  const records = new Map<string, DeliveryOfferReceipt>();
  return {
    records,
    async read(agentId: string, messageId: string) {
      return records.get(`${agentId}:${messageId}`) ?? null;
    },
    async write(receipt: DeliveryOfferReceipt) {
      records.set(`${receipt.agentId}:${receipt.messageId}`, receipt);
    },
  };
}

function holdableJournal() {
  const inner = memoryJournal();
  const writeStarted = deferred<void>();
  const writeContinue = deferred<void>();
  let holdRecorded = true;
  return {
    writeStarted: writeStarted.promise,
    releaseWrite() {
      writeContinue.resolve();
    },
    async read(agentId: string, messageId: string) {
      return inner.read(agentId, messageId);
    },
    async write(receipt: DeliveryOfferReceipt) {
      if (holdRecorded && receipt.state === "recorded") {
        holdRecorded = false;
        writeStarted.resolve();
        await writeContinue.promise;
      }
      return inner.write(receipt);
    },
    inner,
  };
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const workdirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    workdirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 })),
  );
});

async function createHarness(options?: { holdLoad?: boolean }) {
  const workdir = await mkdtemp(path.join(tmpdir(), "paseo-idle-admission-"));
  workdirs.push(workdir);
  const client = new RecordingClient();
  const storage = new AgentStorage(path.join(workdir, "agents"), logger);
  const Manager = options?.holdLoad ? HeldLoadManager : AgentManager;
  const manager = new Manager({
    clients: { codex: client },
    registry: storage,
    logger,
  });
  const agent = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Idle admission" },
    undefined,
    { workspaceId: undefined },
  );
  const session = client.sessions[0];
  if (!session) throw new Error("expected session");
  return { workdir, client, storage, manager, agentId: agent.id, session };
}

describe("AgentManager.tryStartIdleTurn", () => {
  test("reserves the run synchronously so a second caller defers without steering", async () => {
    const { manager, agentId, session } = await createHarness();
    const first = manager.tryStartIdleTurn(agentId, "offer-one", {
      clientMessageId: "msg-one",
    });
    expect(first).not.toBeInstanceOf(Promise);
    expect(first.status).toBe("accepted");
    expect(manager.hasInFlightRun(agentId)).toBe(true);

    const second = manager.tryStartIdleTurn(agentId, "offer-two", {
      clientMessageId: "msg-two",
    });
    expect(second).toEqual({ status: "deferred", deferral: "busy" });
    expect(session.steerCount).toBe(0);
    expect(session.interruptCount).toBe(0);

    if (first.status === "accepted") {
      void drainAsyncGenerator(first.iterator);
    }
    await manager.waitForAgentRunStart(agentId);
    session.complete();
  });

  test("defers pending permissions without clearing them", async () => {
    const { manager, agentId, session } = await createHarness();
    session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      request: PERMISSION_REQUEST,
    });
    await waitUntil(() => manager.getPendingPermissions(agentId).length === 1, "permission");

    const result = manager.tryStartIdleTurn(agentId, "offer", { clientMessageId: "msg" });
    expect(result).toEqual({ status: "deferred", deferral: "pending_permission" });
    expect(manager.getPendingPermissions(agentId)).toHaveLength(1);
    expect(session.steerCount).toBe(0);
    expect(session.interruptCount).toBe(0);
  });
});

describe("delivery offer common-admission races", () => {
  test("defers a normal user send that arrives during journal write without steering", async () => {
    const { manager, storage, agentId, session } = await createHarness();
    const journal = holdableJournal();
    const offerer = new AgentDeliveryOfferer(
      createAgentManagerDeliveryGate(manager, storage, logger),
      journal,
    );

    const offerPromise = offerer.offer({
      agentId,
      text: "background wake",
      messageId: "wake-during-write",
    });
    await journal.writeStarted;

    await sendPromptToAgent({
      agentManager: manager,
      agentStorage: storage,
      agentId,
      prompt: "typed by the user",
      messageId: "user-during-write",
      logger,
    });
    expect(manager.hasInFlightRun(agentId)).toBe(true);

    journal.releaseWrite();
    await expect(offerPromise).resolves.toEqual({
      status: "deferred",
      deferral: "busy",
      error: null,
    });
    expect(session.steerCount).toBe(0);
    expect(session.interruptCount).toBe(0);
    expect(manager.hasInFlightRun(agentId)).toBe(true);
    expect(session.startCount).toBe(1);
    session.complete();
  });

  test("defers a permission that arrives during journal write without clearing it", async () => {
    const { manager, storage, agentId, session } = await createHarness();
    const journal = holdableJournal();
    const offerer = new AgentDeliveryOfferer(
      createAgentManagerDeliveryGate(manager, storage, logger),
      journal,
    );

    const offerPromise = offerer.offer({
      agentId,
      text: "background wake",
      messageId: "wake-perm-write",
    });
    await journal.writeStarted;

    session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      request: PERMISSION_REQUEST,
    });
    await waitUntil(() => manager.getPendingPermissions(agentId).length === 1, "permission");

    journal.releaseWrite();
    await expect(offerPromise).resolves.toEqual({
      status: "deferred",
      deferral: "pending_permission",
      error: null,
    });
    expect(manager.getPendingPermissions(agentId)).toEqual([
      expect.objectContaining({ id: PERMISSION_REQUEST.id }),
    ]);
    expect(session.steerCount).toBe(0);
    expect(session.interruptCount).toBe(0);
    expect(session.startCount).toBe(0);
  });

  test("defers a normal interrupt send that arrives during ensureAgentLoaded without steering", async () => {
    const { manager, storage, agentId, session } = await createHarness({ holdLoad: true });
    const held = manager as HeldLoadManager;
    held.holdLoad = true;
    const offerer = new AgentDeliveryOfferer(
      createAgentManagerDeliveryGate(manager, storage, logger),
      memoryJournal(),
    );

    const offerPromise = offerer.offer({
      agentId,
      text: "background wake",
      messageId: "wake-during-load",
    });
    await held.loadStarted.promise;

    await startAgentRun(manager, agentId, "typed by the user", logger, {
      replaceRunning: true,
      activeTurnBehavior: "interrupt",
      clearPendingPermissions: true,
      runOptions: { clientMessageId: "user-during-load" },
    });
    expect(manager.hasInFlightRun(agentId)).toBe(true);

    held.loadContinue.resolve();
    await expect(offerPromise).resolves.toEqual({
      status: "deferred",
      deferral: "busy",
      error: null,
    });
    expect(session.steerCount).toBe(0);
    expect(session.interruptCount).toBe(0);
    expect(session.startCount).toBe(1);
    session.complete();
  });

  test("defers a permission that arrives during ensureAgentLoaded without clearing it", async () => {
    const { manager, storage, agentId, session } = await createHarness({ holdLoad: true });
    const held = manager as HeldLoadManager;
    held.holdLoad = true;
    const offerer = new AgentDeliveryOfferer(
      createAgentManagerDeliveryGate(manager, storage, logger),
      memoryJournal(),
    );

    const offerPromise = offerer.offer({
      agentId,
      text: "background wake",
      messageId: "wake-perm-load",
    });
    await held.loadStarted.promise;

    session.pushEvent({
      type: "permission_requested",
      provider: "codex",
      request: PERMISSION_REQUEST,
    });
    await waitUntil(() => manager.getPendingPermissions(agentId).length === 1, "permission");

    held.loadContinue.resolve();
    await expect(offerPromise).resolves.toEqual({
      status: "deferred",
      deferral: "pending_permission",
      error: null,
    });
    expect(manager.getPendingPermissions(agentId)).toHaveLength(1);
    expect(session.steerCount).toBe(0);
    expect(session.interruptCount).toBe(0);
    expect(session.startCount).toBe(0);
  });

  test("inspect does not resume an archived provider session", async () => {
    const { manager, storage, agentId, client } = await createHarness();
    await manager.archiveAgent(agentId);
    expect(client.resumeCount).toBe(0);

    const offerer = new AgentDeliveryOfferer(
      createAgentManagerDeliveryGate(manager, storage, logger),
      memoryJournal(),
    );
    await expect(
      offerer.offer({ agentId, text: "wake archived", messageId: "wake-archived" }),
    ).resolves.toEqual({
      status: "rejected",
      deferral: null,
      error: "Agent is archived",
    });
    expect(client.resumeCount).toBe(0);
    expect(manager.getAgent(agentId)).toBeNull();
  });

  test("marks accepted after dispatch reservation and completed after canonical persist", async () => {
    const { manager, storage, agentId, session } = await createHarness();
    const journal = memoryJournal();
    const states: DeliveryOfferReceipt["state"][] = [];
    const originalWrite = journal.write.bind(journal);
    journal.write = async (receipt) => {
      states.push(receipt.state);
      return originalWrite(receipt);
    };
    const offerer = new AgentDeliveryOfferer(
      createAgentManagerDeliveryGate(manager, storage, logger),
      journal,
    );

    await expect(
      offerer.offer({ agentId, text: "wake idle", messageId: "wake-receipt" }),
    ).resolves.toEqual({
      status: "accepted",
      deferral: null,
      error: null,
    });
    expect(states).toEqual(["recorded", "accepted", "completed"]);
    expect(
      manager
        .getTimeline(agentId)
        .some((item) => item.type === "user_message" && item.clientMessageId === "wake-receipt"),
    ).toBe(true);
    session.complete();
  });
});
