import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { waitForAgentRunStartWithTimeout } from "./agent-prompt.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";

export const DeliveryOfferStatusSchema = z.enum(["accepted", "deferred", "duplicate", "rejected"]);
export const DeliveryOfferDeferralSchema = z.enum(["busy", "pending_permission"]);

export type DeliveryOfferStatus = z.infer<typeof DeliveryOfferStatusSchema>;
export type DeliveryOfferDeferral = z.infer<typeof DeliveryOfferDeferralSchema>;

export interface DeliveryOfferResult {
  status: DeliveryOfferStatus;
  deferral: DeliveryOfferDeferral | null;
  error: string | null;
}

export interface DeliveryOfferInput {
  agentId: string;
  text: string;
  messageId: string;
}

export interface DeliveryOfferInspection {
  exists: boolean;
  archived: boolean;
  closed: boolean;
  busy: boolean;
  pendingPermission: boolean;
  hasMessage: boolean;
}

export type DeliveryOfferDispatchResult =
  | { status: "accepted" }
  | { status: "deferred"; deferral: DeliveryOfferDeferral }
  | { status: "rejected"; error: string };

export interface DeliveryOfferGate {
  inspect(agentId: string, messageId: string): Promise<DeliveryOfferInspection>;
  send(input: DeliveryOfferInput): Promise<DeliveryOfferDispatchResult | void>;
}

const ReceiptSchema = z.object({
  agentId: z.string(),
  messageId: z.string(),
  fingerprint: z.string(),
  state: z.enum(["recorded", "accepted", "completed"]),
});
export type DeliveryOfferReceipt = z.infer<typeof ReceiptSchema>;

export interface DeliveryOfferJournal {
  read(agentId: string, messageId: string): Promise<DeliveryOfferReceipt | null>;
  write(receipt: DeliveryOfferReceipt): Promise<void>;
}

export class FileDeliveryOfferJournal implements DeliveryOfferJournal {
  constructor(private readonly directory: string) {}

  async read(agentId: string, messageId: string): Promise<DeliveryOfferReceipt | null> {
    try {
      return ReceiptSchema.parse(
        JSON.parse(await readFile(this.filePath(agentId, messageId), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(receipt: DeliveryOfferReceipt): Promise<void> {
    await mkdir(path.dirname(this.filePath(receipt.agentId, receipt.messageId)), {
      recursive: true,
    });
    await writeJsonFileAtomic(this.filePath(receipt.agentId, receipt.messageId), receipt, {
      mode: 0o600,
    });
  }

  private filePath(agentId: string, messageId: string): string {
    return path.join(this.directory, digest([agentId, messageId]), "receipt.json");
  }
}

export class AgentDeliveryOfferer {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly gate: DeliveryOfferGate,
    private readonly journal: DeliveryOfferJournal,
  ) {}

  async offer(input: DeliveryOfferInput): Promise<DeliveryOfferResult> {
    return this.serialized(input.agentId, () => this.offerLocked(input));
  }

  /** Visible for tests: per-agent serialization tails must not grow without bound. */
  pendingTailCount(): number {
    return this.tails.size;
  }

  private async serialized<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(agentId, tail);
    try {
      return await run;
    } finally {
      if (this.tails.get(agentId) === tail) {
        this.tails.delete(agentId);
      }
    }
  }

  private async offerLocked(input: DeliveryOfferInput): Promise<DeliveryOfferResult> {
    const fingerprint = digest({
      agentId: input.agentId,
      messageId: input.messageId,
      text: input.text,
    });
    const existing = await this.journal.read(input.agentId, input.messageId);
    if (existing && existing.fingerprint !== fingerprint) {
      return {
        status: "rejected",
        deferral: null,
        error: "agent_delivery_key_conflict",
      };
    }

    const inspection = await this.gate.inspect(input.agentId, input.messageId);
    const preAdmit = await this.preAdmitResult(inspection, existing);
    if (preAdmit) {
      return preAdmit;
    }

    // Fingerprint lock only. `accepted` is reserved for actual dispatch admission.
    if (!existing || existing.state === "recorded") {
      await this.journal.write({
        agentId: input.agentId,
        messageId: input.messageId,
        fingerprint,
        state: "recorded",
      });
    }

    let dispatched: DeliveryOfferDispatchResult;
    try {
      dispatched = (await this.gate.send(input)) ?? { status: "accepted" };
    } catch (error) {
      return {
        status: "rejected",
        deferral: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (dispatched.status === "deferred") {
      return { status: "deferred", deferral: dispatched.deferral, error: null };
    }
    if (dispatched.status === "rejected") {
      return { status: "rejected", deferral: null, error: dispatched.error };
    }

    await this.journal.write({
      agentId: input.agentId,
      messageId: input.messageId,
      fingerprint,
      state: "accepted",
    });
    const after = await this.gate.inspect(input.agentId, input.messageId);
    if (after.hasMessage) {
      await this.journal.write({
        agentId: input.agentId,
        messageId: input.messageId,
        fingerprint,
        state: "completed",
      });
    }
    return { status: "accepted", deferral: null, error: null };
  }

  private async preAdmitResult(
    inspection: DeliveryOfferInspection,
    existing: DeliveryOfferReceipt | null,
  ): Promise<DeliveryOfferResult | null> {
    if (inspection.hasMessage || existing?.state === "completed") {
      if (existing && existing.state !== "completed") {
        await this.journal.write({ ...existing, state: "completed" });
      }
      return { status: "duplicate", deferral: null, error: null };
    }
    if (!inspection.exists) {
      return { status: "rejected", deferral: null, error: "Agent not found" };
    }
    if (inspection.archived) {
      return { status: "rejected", deferral: null, error: "Agent is archived" };
    }
    if (inspection.closed) {
      return { status: "rejected", deferral: null, error: "Agent is closed" };
    }
    if (inspection.pendingPermission) {
      return { status: "deferred", deferral: "pending_permission", error: null };
    }
    if (inspection.busy) {
      return { status: "deferred", deferral: "busy", error: null };
    }
    return null;
  }
}

export function createAgentManagerDeliveryGate(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  logger: Logger,
): DeliveryOfferGate {
  return {
    async inspect(agentId, messageId) {
      const record = await agentStorage.get(agentId);
      if (!record) {
        return {
          exists: false,
          archived: false,
          closed: false,
          busy: false,
          pendingPermission: false,
          hasMessage: false,
        };
      }
      // Archived history must not resume a provider session as a read side effect.
      if (record.archivedAt) {
        return {
          exists: true,
          archived: true,
          closed: false,
          busy: false,
          pendingPermission: false,
          hasMessage: false,
        };
      }
      const liveBeforeLoad = agentManager.getAgent(agentId);
      if (!liveBeforeLoad && record.lastStatus === "closed") {
        return {
          exists: true,
          archived: false,
          closed: true,
          busy: false,
          pendingPermission: false,
          hasMessage: false,
        };
      }

      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger,
      });
      const snapshot = agentManager.getAgent(agentId);
      const wakeAlreadyPresent = (item: { type: string; clientMessageId?: string }): boolean =>
        item.type === "user_message" && item.clientMessageId === messageId;
      const liveHasMessage = snapshot
        ? agentManager.getTimeline(agentId).some(wakeAlreadyPresent)
        : false;
      const durableHasMessage = snapshot
        ? (await agentManager.getTimelineRows(agentId)).some((row) => wakeAlreadyPresent(row.item))
        : false;
      const closed = snapshot ? snapshot.lifecycle === "closed" : record.lastStatus === "closed";
      const canQuerySession = Boolean(
        snapshot && snapshot.lifecycle !== "closed" && snapshot.session,
      );
      return {
        exists: true,
        archived: false,
        closed,
        busy: canQuerySession ? agentManager.hasInFlightRun(agentId) : false,
        pendingPermission: canQuerySession
          ? agentManager.getPendingPermissions(agentId).length > 0
          : false,
        hasMessage: liveHasMessage || durableHasMessage,
      };
    },
    async send(input) {
      const admission = await agentManager.admitIdleForegroundTurn(input.agentId, input.text, {
        clientMessageId: input.messageId,
      });
      if (admission.status === "deferred") {
        return { status: "deferred", deferral: admission.deferral };
      }
      if (admission.status === "rejected") {
        return { status: "rejected", error: idleRejectionMessage(admission.reason) };
      }
      void drainAgentRunIterator(admission.iterator).catch((error: unknown) => {
        logger.warn({ err: error, agentId: input.agentId }, "Delivery offer run failed");
      });
      await waitForAgentRunStartWithTimeout(agentManager, input.agentId);
      return { status: "accepted" };
    },
  };
}

export function createDaemonDeliveryOfferer(
  paseoHome: string,
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  logger: Logger,
): AgentDeliveryOfferer {
  return new AgentDeliveryOfferer(
    createAgentManagerDeliveryGate(agentManager, agentStorage, logger),
    new FileDeliveryOfferJournal(path.join(paseoHome, "agent-delivery-offers")),
  );
}

export function resolveDaemonDeliveryOfferer(
  paseoHome: string,
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  logger: Logger,
  existing?: AgentDeliveryOfferer,
): AgentDeliveryOfferer {
  return existing ?? createDaemonDeliveryOfferer(paseoHome, agentManager, agentStorage, logger);
}

function idleRejectionMessage(reason: "not_found" | "archived" | "closed"): string {
  if (reason === "not_found") return "Agent not found";
  if (reason === "archived") return "Agent is archived";
  return "Agent is closed";
}

async function drainAgentRunIterator(iterator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
