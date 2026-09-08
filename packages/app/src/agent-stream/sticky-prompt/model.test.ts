import { describe, expect, it, vi } from "vitest";
import {
  STICKY_PROMPT_COLLAPSE_CHAR_LIMIT,
  createStickyPromptPublisher,
  createStickyPromptRowIndex,
  findStickyPromptReadingRowId,
  resolveStickyPromptId,
  shouldCollapseStickyPrompt,
} from "./model";

const PROMPT_IDS = ["p1", "p2", "p3"];
const ROWS = [
  { id: "p1", kind: "user_message" },
  { id: "a1", kind: "assistant_message" },
  { id: "p2", kind: "user_message" },
  { id: "a2", kind: "assistant_message" },
  { id: "p3", kind: "user_message" },
  { id: "a3", kind: "assistant_message" },
];

function resolve(input: { availablePromptIds?: string[]; readingRowId: string | null }) {
  const index = createStickyPromptRowIndex({
    items: ROWS,
    promptIds: PROMPT_IDS,
  });
  const availablePromptIds =
    input.availablePromptIds === undefined
      ? index.availablePromptIds
      : new Set(input.availablePromptIds);
  return resolveStickyPromptId({
    index: { ...index, availablePromptIds },
    readingRowId: input.readingRowId,
  });
}

function readingRow(
  rows: Array<{ id: string; top: number; bottom: number }>,
  viewportTop = 0,
): string | null {
  return findStickyPromptReadingRowId(rows, viewportTop);
}

describe("sticky prompt model", () => {
  it("waits for the actual prompt edge instead of the outline reading line", () => {
    expect(readingRow([{ id: "p1", top: 1.1, bottom: 24 }])).toBeNull();
    expect(readingRow([{ id: "p1", top: 1, bottom: 24 }])).toBe("p1");
    expect(readingRow([{ id: "p1", top: -20, bottom: 24 }])).toBe("p1");
    expect(
      readingRow([
        { id: "old", top: -400, bottom: -200 },
        { id: "future", top: 80, bottom: 160 },
      ]),
    ).toBeNull();
  });

  it("maps an answer row to its prompt when the prompt row is unmounted", () => {
    expect(resolve({ readingRowId: "a2" })).toBe("p2");
  });

  it("switches and restores as the measured reading row crosses prompts", () => {
    expect(resolve({ readingRowId: readingRow([{ id: "p2", top: 0, bottom: 24 }]) })).toBe("p2");
    expect(resolve({ readingRowId: "a1" })).toBe("p1");
  });

  it("restores a virtualized earlier prompt but not an omitted older page", () => {
    expect(resolve({ readingRowId: "a1" })).toBe("p1");
    expect(resolve({ availablePromptIds: ["p2", "p3"], readingRowId: "a1" })).toBeNull();
  });

  it("does not preserve an old pin through an unobserved jump", () => {
    expect(resolve({ readingRowId: "a2" })).toBe("p2");
    expect(resolve({ readingRowId: null })).toBeNull();
  });

  it("does not notify subscribers for repeated prompt IDs", () => {
    const publisher = createStickyPromptPublisher();
    const listener = vi.fn();
    publisher.subscribe(listener);

    publisher.publish("p1");
    publisher.publish("p1");
    publisher.publish(null);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(publisher.getActivePromptId()).toBeNull();
  });

  it("collapses long and newline-heavy prompts", () => {
    expect(shouldCollapseStickyPrompt("x".repeat(STICKY_PROMPT_COLLAPSE_CHAR_LIMIT))).toBe(false);
    expect(shouldCollapseStickyPrompt("x".repeat(STICKY_PROMPT_COLLAPSE_CHAR_LIMIT + 1))).toBe(
      true,
    );
    expect(shouldCollapseStickyPrompt("one\ntwo\nthree\nfour")).toBe(true);
  });
});
