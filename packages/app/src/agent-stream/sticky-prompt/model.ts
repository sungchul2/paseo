export interface StickyPromptItem {
  id: string;
  text: string;
}

export interface StickyPromptSource {
  subscribe: (listener: () => void) => () => void;
  getActivePromptId: () => string | null;
}

export interface StickyPromptPublisher extends StickyPromptSource {
  publish: (promptId: string | null) => void;
}

export interface StickyPromptRowItem {
  id: string;
  kind: string;
}

export interface StickyPromptRowIndex {
  promptIds: readonly string[];
  knownPromptIds: ReadonlySet<string>;
  availablePromptIds: ReadonlySet<string>;
  promptForRowId: ReadonlyMap<string, string | null>;
}

export interface StickyPromptRowPosition {
  id: string;
  top: number;
  bottom: number;
}

/** A prompt becomes sticky at its own top edge, with a small allowance for native rounding. */
export const STICKY_PROMPT_TOP_EPSILON_PX = 1;

/** Keep the preview bounded even when a prompt contains a very long unbroken line. */
export const STICKY_PROMPT_COLLAPSE_CHAR_LIMIT = 240;
export const STICKY_PROMPT_COLLAPSE_LINE_LIMIT = 3;

export function shouldCollapseStickyPrompt(text: string): boolean {
  return (
    text.length > STICKY_PROMPT_COLLAPSE_CHAR_LIMIT ||
    text.split(/\r?\n/).length > STICKY_PROMPT_COLLAPSE_LINE_LIMIT
  );
}

/**
 * Build the ordered membership used when a prompt cell is virtualized away while its answer is
 * still visible. This runs when a segment changes, not in the scroll callback.
 */
export function createStickyPromptRowIndex(input: {
  items: readonly StickyPromptRowItem[];
  promptIds: readonly string[];
}): StickyPromptRowIndex {
  const knownPromptIds = new Set(input.promptIds);
  const availablePromptIds = new Set<string>();
  const promptForRowId = new Map<string, string | null>();
  let currentPromptId: string | null = null;

  for (const item of input.items) {
    if (item.kind === "user_message") {
      currentPromptId = item.id;
      if (knownPromptIds.has(item.id)) {
        availablePromptIds.add(item.id);
      }
    }
    promptForRowId.set(item.id, currentPromptId);
  }

  return {
    promptIds: input.promptIds,
    knownPromptIds,
    availablePromptIds,
    promptForRowId,
  };
}

/**
 * Find the row at the viewport's actual top boundary. A preceding row is retained only across a
 * sub-pixel gap between cells; stale geometry from a previous viewport cannot keep a prompt pinned.
 */
export function findStickyPromptReadingRowId(
  rows: readonly StickyPromptRowPosition[],
  viewportTop: number,
): string | null {
  if (!Number.isFinite(viewportTop)) {
    return null;
  }

  let crossingRow: StickyPromptRowPosition | null = null;
  let precedingRow: StickyPromptRowPosition | null = null;
  const edge = viewportTop + STICKY_PROMPT_TOP_EPSILON_PX;
  for (const row of rows) {
    if (!Number.isFinite(row.top) || !Number.isFinite(row.bottom) || row.top > edge) {
      continue;
    }
    if (!precedingRow || row.top > precedingRow.top) {
      precedingRow = row;
    }
    if (row.bottom > viewportTop && (!crossingRow || row.top > crossingRow.top)) {
      crossingRow = row;
    }
  }
  if (crossingRow) {
    return crossingRow.id;
  }
  if (precedingRow && precedingRow.bottom >= viewportTop - STICKY_PROMPT_TOP_EPSILON_PX) {
    return precedingRow.id;
  }
  return null;
}

/** Resolve a measured reading row to the prompt that owns its answer. */
export function resolveStickyPromptId(input: {
  index: StickyPromptRowIndex;
  readingRowId: string | null;
}): string | null {
  if (input.readingRowId === null) {
    return null;
  }
  const promptId = input.index.promptForRowId.get(input.readingRowId);
  if (!promptId || !input.index.knownPromptIds.has(promptId)) {
    return null;
  }
  return input.index.availablePromptIds.has(promptId) ? promptId : null;
}

/** Keep prompt state out of the scroll/render loop. Subscribers run only when the pin changes. */
export function createStickyPromptPublisher(): StickyPromptPublisher {
  const listeners = new Set<() => void>();
  let activePromptId: string | null = null;

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getActivePromptId: () => activePromptId,
    publish(promptId) {
      if (promptId === activePromptId) {
        return;
      }
      activePromptId = promptId;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}
