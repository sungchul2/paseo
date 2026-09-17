import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  sendPromptToAgent,
  waitForAgentRunStartWithTimeout,
  type SendPromptToAgentParams,
} from "./agent-prompt.js";

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

export interface DeliveryOfferGate {
  inspect(agentId: string, messageId: string): Promise<DeliveryOfferInspection>;
  send(input: DeliveryOfferInput): Promise<void>;
}

const ReceiptSchema = z.object({
  agentId: z.string(),
  messageId: z.string(),
  fingerprint: z.string(),
  state: z.enum(["accepted", "completed"]),
});
type Receipt = z.infer<typeof ReceiptSchema>;

export interface DeliveryOfferJournal {
  read(agentId: string, messageId: string): Promise<Receipt | null>;
  write(receipt: Receipt): Promise<void>;
}

export class FileDeliveryOfferJournal implements DeliveryOfferJournal {
  constructor(private readonly directory: string) {}

  async read(agentId: string, messageId: string): Promise<Receipt | null> {
    try {
      return ReceiptSchema.parse(
        JSON.parse(await readFile(this.filePath(agentId, messageId), "utf8")),
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async write(receipt: Receipt): Promise<void> {
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

  private async serialized<T>(agentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      agentId,
      previous.then(() => gate).catch(() => gate),
    );
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
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
    if (existing?.state !== "accepted") {
      await this.journal.write({
        agentId: input.agentId,
        messageId: input.messageId,
        fingerprint,
        state: "accepted",
      });
    }

    try {
      await this.gate.send(input);
    } catch (error) {
      return {
        status: "rejected",
        deferral: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await this.journal.write({
      agentId: input.agentId,
      messageId: input.messageId,
      fingerprint,
      state: "completed",
    });
    return { status: "accepted", deferral: null, error: null };
  }
}

export function createAgentManagerDeliveryGate(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  logger: SendPromptToAgentParams["logger"],
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
      await ensureAgentLoaded(agentId, {
        agentManager,
        agentStorage,
        logger,
      });
      const snapshot = agentManager.getAgent(agentId);
      const wakeAlreadyPresent = (item: { type: string; clientMessageId?: string }): boolean =>
        item.type === "user_message" && item.clientMessageId === messageId;
      const liveHasMessage = agentManager.getTimeline(agentId).some(wakeAlreadyPresent);
      const durableHasMessage = (await agentManager.getTimelineRows(agentId)).some((row) =>
        wakeAlreadyPresent(row.item),
      );
      return {
        exists: true,
        archived: Boolean(record.archivedAt),
        closed: snapshot ? snapshot.lifecycle === "closed" : record.lastStatus === "closed",
        busy: agentManager.hasInFlightRun(agentId),
        pendingPermission: agentManager.getPendingPermissions(agentId).length > 0,
        hasMessage: liveHasMessage || durableHasMessage,
      };
    },
    async send(input) {
      const disposition = await sendPromptToAgent({
        agentManager,
        agentStorage,
        agentId: input.agentId,
        prompt: input.text,
        messageId: input.messageId,
        activeTurnBehavior: "steer",
        replaceRunning: false,
        clearPendingPermissions: false,
        unarchive: false,
        logger,
      });
      if (disposition.disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(agentManager, input.agentId);
      }
    },
  };
}

export function createDaemonDeliveryOfferer(
  paseoHome: string,
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  logger: SendPromptToAgentParams["logger"],
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
  logger: SendPromptToAgentParams["logger"],
  existing?: AgentDeliveryOfferer,
): AgentDeliveryOfferer {
  return existing ?? createDaemonDeliveryOfferer(paseoHome, agentManager, agentStorage, logger);
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
