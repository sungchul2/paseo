import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import { PluginRuntime } from "./runtime.js";
import type { PluginSessionSocket } from "./session-socket.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function createPlugin(id: string, source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-delivery-"));
  temporaryDirectories.push(directory);
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id, requirements: { paseo: ">=0.8.0" } }),
    "utf8",
  );
  await writeFile(path.join(directory, "index.server.ts"), source, "utf8");
  return directory;
}

function createSessionHost(options: {
  advertiseDeliveryOffer: boolean;
  offerStatus?: "accepted" | "deferred" | "duplicate" | "rejected";
  offerDeferral?: "busy" | "pending_permission" | null;
}) {
  const sentTypes: string[] = [];
  return {
    sentTypes,
    host: {
      async attachPluginSocket(_pluginId: string, socket: PluginSessionSocket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string") return;
          const frame = JSON.parse(data) as {
            type?: string;
            message?: {
              type?: string;
              requestId?: string;
              agentId?: string;
              text?: string;
              messageId?: string;
            };
          };
          sentTypes.push(frame.message?.type ?? frame.type ?? "unknown");
          if (frame.type === "hello") {
            socket.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "status",
                  payload: {
                    status: "server_info",
                    serverId: "plugin-delivery-offer",
                    hostname: "plugin-delivery-offer",
                    version: "0.8.0",
                    features: options.advertiseDeliveryOffer ? { agentDeliveryOffer: true } : {},
                  },
                },
              }),
            );
            return;
          }
          if (frame.type === "session" && frame.message?.type === "agent.delivery.offer.request") {
            socket.send(
              JSON.stringify({
                type: "session",
                message: {
                  type: "agent.delivery.offer.response",
                  payload: {
                    requestId: frame.message.requestId,
                    agentId: frame.message.agentId,
                    status: options.offerStatus ?? "accepted",
                    deferral: options.offerDeferral ?? null,
                    error: null,
                  },
                },
              }),
            );
          }
        });
        return { closed };
      },
    },
  };
}

const PROBE_PLUGIN = `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export default function contribute(server) {
  server.handle(
    defineRpc({
      name: "probe.delivery",
      input: z.object({ agentId: z.string() }),
      output: z.object({
        advertised: z.boolean(),
        offerWhenIdle: z.boolean(),
        send: z.boolean(),
      }),
    }),
    (input, context) => {
      const handle = context.paseo.agents.ref(input.agentId);
      return {
        advertised: context.paseo.features.agentDeliveryOffer === true,
        offerWhenIdle: typeof handle.offerWhenIdle === "function",
        send: typeof handle.send === "function",
      };
    },
  );
  server.handle(
    defineRpc({
      name: "offer.delivery",
      input: z.object({
        agentId: z.string(),
        text: z.string(),
        messageId: z.string(),
      }),
      output: z.object({
        status: z.string(),
        deferral: z.string().nullable(),
        error: z.string().nullable(),
      }),
    }),
    async (input, context) => {
      const result = await context.paseo.agents.ref(input.agentId).offerWhenIdle(input.text, {
        messageId: input.messageId,
      });
      return {
        status: result.status,
        deferral: result.deferral,
        error: result.error,
      };
    },
  );
  return () => {};
}`;

it("plugin IPC sees injected PaseoApi.features from server_info and offerWhenIdle without send", async () => {
  const advertised = createSessionHost({
    advertiseDeliveryOffer: true,
    offerStatus: "deferred",
    offerDeferral: "pending_permission",
  });
  const absent = createSessionHost({ advertiseDeliveryOffer: false });
  const advertisedRuntime = new PluginRuntime(pino({ level: "silent" }), "0.8.0", {
    sessionHost: advertised.host,
  });
  const absentRuntime = new PluginRuntime(pino({ level: "silent" }), "0.8.0", {
    sessionHost: absent.host,
  });
  const advertisedDir = await createPlugin("delivery-advertised", PROBE_PLUGIN);
  const absentDir = await createPlugin("delivery-absent", PROBE_PLUGIN);
  try {
    await advertisedRuntime.startPlugin("delivery-advertised", advertisedDir);
    await absentRuntime.startPlugin("delivery-absent", absentDir);

    await expect(
      advertisedRuntime.invoke("delivery-advertised", "probe.delivery", { agentId: "agent-1" }),
    ).resolves.toEqual({
      advertised: true,
      offerWhenIdle: true,
      send: true,
    });
    await expect(
      absentRuntime.invoke("delivery-absent", "probe.delivery", { agentId: "agent-1" }),
    ).resolves.toEqual({
      advertised: false,
      offerWhenIdle: true,
      send: true,
    });

    await expect(
      advertisedRuntime.invoke("delivery-advertised", "offer.delivery", {
        agentId: "agent-1",
        text: "continue",
        messageId: "wake-1",
      }),
    ).resolves.toEqual({
      status: "deferred",
      deferral: "pending_permission",
      error: null,
    });
    expect(advertised.sentTypes).toContain("agent.delivery.offer.request");
    expect(advertised.sentTypes).not.toContain("send_agent_message_request");
  } finally {
    await advertisedRuntime.stopAll();
    await absentRuntime.stopAll();
  }
});
