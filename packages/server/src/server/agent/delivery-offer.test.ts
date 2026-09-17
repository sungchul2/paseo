import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import {
  AgentDeliveryOfferer,
  FileDeliveryOfferJournal,
  type DeliveryOfferGate,
  type DeliveryOfferInput,
  type DeliveryOfferInspection,
} from "./delivery-offer.js";

const idle: DeliveryOfferInspection = {
  exists: true,
  archived: false,
  closed: false,
  busy: false,
  pendingPermission: false,
  hasMessage: false,
};

function input(overrides?: Partial<DeliveryOfferInput>): DeliveryOfferInput {
  return {
    agentId: "agent-1",
    messageId: "paseo-watchdog-wake:job-1",
    text: "job finished",
    ...overrides,
  };
}

function createGate(
  state: DeliveryOfferInspection,
  send: DeliveryOfferGate["send"],
): DeliveryOfferGate {
  return {
    inspect: vi.fn(async () => ({ ...state })),
    send,
  };
}

describe("AgentDeliveryOfferer", () => {
  test("accepts an idle agent without interrupting or clearing permissions", async () => {
    const send = vi.fn(async () => undefined);
    const offerer = new AgentDeliveryOfferer(createGate(idle, send), memoryJournal());

    await expect(offerer.offer(input())).resolves.toEqual({
      status: "accepted",
      deferral: null,
      error: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(input());
  });

  test("defers when the agent is busy and does not send", async () => {
    const send = vi.fn(async () => undefined);
    const offerer = new AgentDeliveryOfferer(
      createGate({ ...idle, busy: true }, send),
      memoryJournal(),
    );

    await expect(offerer.offer(input())).resolves.toEqual({
      status: "deferred",
      deferral: "busy",
      error: null,
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("defers pending permissions without sending", async () => {
    const send = vi.fn(async () => undefined);
    const offerer = new AgentDeliveryOfferer(
      createGate({ ...idle, pendingPermission: true }, send),
      memoryJournal(),
    );

    await expect(offerer.offer(input())).resolves.toEqual({
      status: "deferred",
      deferral: "pending_permission",
      error: null,
    });
    expect(send).not.toHaveBeenCalled();
  });

  test("serializes two concurrent deliverers so only one send is accepted", async () => {
    let inspecting = 0;
    let peak = 0;
    let sent = 0;
    const gate: DeliveryOfferGate = {
      inspect: async () => {
        inspecting += 1;
        peak = Math.max(peak, inspecting);
        await Promise.resolve();
        const snapshot = {
          ...idle,
          busy: sent > 0,
        };
        inspecting -= 1;
        return snapshot;
      },
      send: async () => {
        sent += 1;
      },
    };
    const offerer = new AgentDeliveryOfferer(gate, memoryJournal());
    const first = offerer.offer(input({ messageId: "wake-a" }));
    const second = offerer.offer(input({ messageId: "wake-b", text: "other" }));
    const results = await Promise.all([first, second]);

    expect(peak).toBe(1);
    expect(sent).toBe(1);
    expect(results.filter((result) => result.status === "accepted")).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "deferred" && result.deferral === "busy"),
    ).toHaveLength(1);
  });

  test("retries send after crash past acceptance when the timeline still lacks the message", async () => {
    let attempts = 0;
    const send = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("process died after accept");
    });
    const offerer = new AgentDeliveryOfferer(createGate(idle, send), memoryJournal());

    await expect(offerer.offer(input())).resolves.toEqual({
      status: "rejected",
      deferral: null,
      error: "process died after accept",
    });
    await expect(offerer.offer(input())).resolves.toEqual({
      status: "accepted",
      deferral: null,
      error: null,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("does not resend after crash when the timeline already has the message", async () => {
    const state = { ...idle, hasMessage: false };
    const send = vi.fn(async () => {
      throw new Error("process died after accept");
    });
    const offerer = new AgentDeliveryOfferer(
      {
        inspect: async () => ({ ...state }),
        send,
      },
      memoryJournal(),
    );
    await expect(offerer.offer(input())).resolves.toMatchObject({ status: "rejected" });
    state.hasMessage = true;
    await expect(offerer.offer(input())).resolves.toEqual({
      status: "duplicate",
      deferral: null,
      error: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("keeps an accepted receipt queued until the agent is idle again", async () => {
    const state = { ...idle };
    const send = vi.fn(async () => {
      throw new Error("process died after accept");
    });
    const offerer = new AgentDeliveryOfferer(
      {
        inspect: async () => ({ ...state }),
        send,
      },
      memoryJournal(),
    );
    await expect(offerer.offer(input())).resolves.toMatchObject({ status: "rejected" });
    state.busy = true;
    await expect(offerer.offer(input())).resolves.toEqual({
      status: "deferred",
      deferral: "busy",
      error: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
    state.busy = false;
    send.mockImplementation(async () => undefined);
    await expect(offerer.offer(input())).resolves.toEqual({
      status: "accepted",
      deferral: null,
      error: null,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("treats a second offer of the same message identity as duplicate", async () => {
    const send = vi.fn(async () => undefined);
    const offerer = new AgentDeliveryOfferer(createGate(idle, send), memoryJournal());

    await expect(offerer.offer(input())).resolves.toMatchObject({ status: "accepted" });
    await expect(offerer.offer(input())).resolves.toEqual({
      status: "duplicate",
      deferral: null,
      error: null,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("rejects a reused message id with a different body", async () => {
    const send = vi.fn(async () => undefined);
    const offerer = new AgentDeliveryOfferer(createGate(idle, send), memoryJournal());
    await offerer.offer(input());

    await expect(offerer.offer(input({ text: "changed" }))).resolves.toEqual({
      status: "rejected",
      deferral: null,
      error: "agent_delivery_key_conflict",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("file journal survives offerer reconstruction", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-delivery-offer-"));
    try {
      const send = vi.fn(async () => undefined);
      const first = new AgentDeliveryOfferer(
        createGate(idle, send),
        new FileDeliveryOfferJournal(directory),
      );
      await expect(first.offer(input())).resolves.toMatchObject({ status: "accepted" });
      const second = new AgentDeliveryOfferer(
        createGate(idle, send),
        new FileDeliveryOfferJournal(directory),
      );
      await expect(second.offer(input())).resolves.toMatchObject({ status: "duplicate" });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function memoryJournal() {
  const records = new Map<
    string,
    { agentId: string; messageId: string; fingerprint: string; state: "accepted" | "completed" }
  >();
  return {
    async read(agentId: string, messageId: string) {
      return records.get(`${agentId}:${messageId}`) ?? null;
    },
    async write(receipt: {
      agentId: string;
      messageId: string;
      fingerprint: string;
      state: "accepted" | "completed";
    }) {
      records.set(`${receipt.agentId}:${receipt.messageId}`, receipt);
    },
  };
}
