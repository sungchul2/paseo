import path from "node:path";
import type { Logger } from "pino";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import type { AgentDeliveryOfferer } from "../agent/delivery-offer.js";
import { formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import type { StoredWatchdogJob, WatchdogNotifier } from "./service.js";

export function watchdogWakeClientMessageId(jobId: string): string {
  return `paseo-watchdog-wake:${jobId}`;
}

export class AgentWatchdogNotifier implements WatchdogNotifier {
  constructor(
    private readonly paseoHome: string,
    private readonly agentManager: AgentManager,
    private readonly agentStorage: AgentStorage,
    private readonly logger: Logger,
    private readonly deliveryOffers: AgentDeliveryOfferer,
  ) {}

  async notify(job: StoredWatchdogJob): Promise<"delivered" | "busy"> {
    const record = await this.agentStorage.get(job.agentId);
    if (!record) {
      throw new Error(`Watchdog target agent ${job.agentId} no longer exists`);
    }
    if (record.archivedAt) {
      throw new Error(`Watchdog target agent ${job.agentId} is archived`);
    }

    const agent = await ensureAgentLoaded(job.agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });

    const result = job.result;
    let outcome = `exit code ${result?.exitCode ?? "unknown"}`;
    if (result?.error) {
      outcome = `worker error: ${result.error}`;
    } else if (result?.signal) {
      outcome = `terminated by ${result.signal}`;
    }
    const logsDirectory = path.join(this.paseoHome, "watchdogs", "logs");
    const streamSummary = [
      result?.stdout
        ? `stdout bytes=${result.stdout.bytes} truncated=${result.stdout.truncated}`
        : null,
      result?.stderr
        ? `stderr bytes=${result.stderr.bytes} truncated=${result.stderr.truncated}`
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const body = [
      `[PASEO_WATCHDOG job=${job.id}]`,
      `Durable background job "${job.name}" finished with ${outcome}.`,
      `stdout: ${path.join(logsDirectory, `${job.id}.stdout.log`)}`,
      `stderr: ${path.join(logsDirectory, `${job.id}.stderr.log`)}`,
      ...(streamSummary ? [streamSummary] : []),
      "Inspect the artifacts, report the real result, and continue the interrupted task. Do not rerun the job unless the artifacts show it is necessary.",
    ].join("\n");

    const offer = await this.deliveryOffers.offer({
      agentId: agent.id,
      messageId: watchdogWakeClientMessageId(job.id),
      text: formatSystemNotificationPrompt(body),
    });
    if (offer.status === "deferred") {
      return "busy";
    }
    if (offer.status === "accepted" || offer.status === "duplicate") {
      return "delivered";
    }
    throw new Error(offer.error ?? "Watchdog delivery rejected");
  }
}
