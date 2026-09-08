import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import {
  chatOutlineRail,
  disableChatOutlineFromAppearance,
  expectNoChatOutline,
} from "../support/helpers/chat-outline";
import {
  expectTimelinePromptNotMounted,
  expectTimelinePromptLandedBelowTop,
  expectTimelinePromptVisible,
  openAgentTimeline,
  seedLongMockAgentTimeline,
  scrollTimelineUntilOlderHistoryIsReachable,
  type LongTimelineAgent,
} from "../support/helpers/timeline-pagination";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const WIDE_VIEWPORT = { width: 1440, height: 900 };
const MOBILE_VIEWPORT = { width: 480, height: 900 };

test.describe.configure({ timeout: 180_000 });

function timeline(page: Page) {
  return page.locator('[data-testid="agent-chat-scroll"]:visible').first();
}

async function readScrollOffset(page: Page): Promise<number> {
  return timeline(page).evaluate((element) => element.scrollTop);
}

async function scrollPromptToActualTop(page: Page, prompt: string): Promise<void> {
  const scroll = timeline(page);
  await expect(scroll.getByTestId("user-message").first()).toBeVisible();
  const row = scroll.locator("[data-history-row-id]").filter({ hasText: prompt }).first();
  await scrollTimelineUntilOlderHistoryIsReachable(page, prompt);
  await expect(row).toBeVisible({ timeout: 30_000 });

  // Mark this as upward user intent before asking the DOM virtualizer to reveal the row. The
  // exact adjustment below tests the sticky boundary itself, rather than the outline's +8 line.
  await scroll.dispatchEvent("wheel", { deltaY: -1 });
  await row.scrollIntoViewIfNeeded();
  await row.evaluate((element) => {
    const scrollContainer = element.closest('[data-testid="agent-chat-scroll"]');
    if (!(scrollContainer instanceof HTMLElement)) {
      throw new Error("Expected a timeline scroll container");
    }
    const delta = element.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
    scrollContainer.scrollTop += delta;
    scrollContainer.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect
    .poll(async () => {
      const [scrollBox, rowBox] = await Promise.all([scroll.boundingBox(), row.boundingBox()]);
      if (!scrollBox || !rowBox) {
        return Number.POSITIVE_INFINITY;
      }
      return Math.abs(rowBox.y - scrollBox.y);
    })
    .toBeLessThanOrEqual(1);
}

async function expectPinnedPrompt(page: Page, prompt: string): Promise<void> {
  const sticky = page.getByTestId("sticky-prompt");
  await expect(sticky).toBeVisible();
  await expect(sticky.getByTestId("sticky-prompt-text")).toHaveText(prompt);
}

async function expectNoPinnedPrompt(page: Page): Promise<void> {
  await expect(page.getByTestId("sticky-prompt")).toHaveCount(0);
}

test.describe("sticky prompt", () => {
  let agent: LongTimelineAgent;

  test.beforeAll(async () => {
    agent = await seedLongMockAgentTimeline({ turns: 18 });
  });

  test.afterAll(async () => {
    await agent.cleanup();
  });

  test("pins at the question edge, switches, and restores while outline is disabled", async ({
    page,
  }) => {
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    await disableChatOutlineFromAppearance(page);
    await expectNoChatOutline(page);

    await scrollPromptToActualTop(page, agent.prompts[3]);
    await expectPinnedPrompt(page, agent.prompts[3]);

    await page.screenshot({ path: test.info().outputPath("question-pinned.png") });

    await scrollPromptToActualTop(page, agent.prompts[6]);
    await expectPinnedPrompt(page, agent.prompts[6]);

    await page.screenshot({ path: test.info().outputPath("next-question-pinned.png") });

    await scrollPromptToActualTop(page, agent.prompts[3]);
    await expectPinnedPrompt(page, agent.prompts[3]);
  });

  test("keeps the reader's prompt when a newer turn streams below it", async ({ page }) => {
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);

    const earlierPrompt = agent.prompts[4];
    await scrollPromptToActualTop(page, earlierPrompt);
    await expectPinnedPrompt(page, earlierPrompt);

    const before = await readScrollOffset(page);

    const incomingPrompt = "sticky prompt incoming turn while reading an earlier answer";
    await agent.client.sendAgentMessage(agent.agentId, incomingPrompt);
    await expectTimelinePromptVisible(page, incomingPrompt);
    await expectPinnedPrompt(page, earlierPrompt);
    await expect.poll(() => readScrollOffset(page)).toBe(before);

    await agent.client.waitForFinish(agent.agentId, 15_000);
    await expectPinnedPrompt(page, earlierPrompt);
  });

  test("works on the compact web layout and does not default to the newest message", async ({
    page,
  }) => {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openAgentTimeline(page, agent);
    await scrollPromptToActualTop(page, agent.prompts[2]);
    await expectPinnedPrompt(page, agent.prompts[2]);
    await page.screenshot({ path: test.info().outputPath("compact-question-pinned.png") });
  });
});

test("shows no pinned header before the first question reaches the top", async ({ page }) => {
  const agent = await seedLongMockAgentTimeline({ turns: 1 });
  try {
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);

    await expectTimelinePromptVisible(page, agent.oldestPrompt);
    await expectNoPinnedPrompt(page);
  } finally {
    await agent.cleanup();
  }
});

test("restores the question when its cell is virtualized out of a long answer", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Reflect.set(globalThis, "__PASEO_E2E_WEB_PARTIAL_VIRTUALIZATION_THRESHOLD", 1);
    Reflect.set(globalThis, "__PASEO_E2E_WEB_MOUNTED_RECENT_STREAM_ITEMS", 2);
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "sticky-prompt-virtual-",
    title: "Sticky prompt virtualized response",
    model: "ten-second-stream",
  });
  const prompt = "Explain the long response in detail for sticky question navigation";
  const nextPrompt = "follow-up-0: emit 1 coalesced agent stream updates";
  try {
    await agent.client.sendAgentMessage(agent.agentId, prompt);
    await agent.client.waitForFinish(agent.agentId, 20_000);
    for (let index = 0; index < 12; index += 1) {
      await agent.client.sendAgentMessage(
        agent.agentId,
        `follow-up-${index}: emit 1 coalesced agent stream updates`,
      );
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    const prompts = chatOutlineRail(page).getByRole("tab");
    await expect(prompts).toHaveCount(13);
    await prompts.first().click();
    await expectTimelinePromptLandedBelowTop(page, prompt);
    await prompts.nth(1).click();
    await expectTimelinePromptLandedBelowTop(page, nextPrompt);
    await timeline(page).dispatchEvent("wheel", { deltaY: -200 });
    await timeline(page).evaluate((element) => {
      element.scrollTop -= 200;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expectTimelinePromptNotMounted(page, prompt);
    await expectPinnedPrompt(page, prompt);
    await page.screenshot({ path: test.info().outputPath("virtualized-question-pinned.png") });
  } finally {
    await agent.cleanup();
  }
});

test("expands a compact long prompt to its full content", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "sticky-prompt-long-",
    title: "Sticky prompt long content",
    model: "e2e-fast-stream",
  });
  const longPrompt = `sticky long prompt ${"with expandable context ".repeat(30)}`.trim();
  try {
    await agent.client.sendAgentMessage(agent.agentId, longPrompt);
    await agent.client.waitForFinish(agent.agentId, 15_000);
    for (let index = 0; index < 3; index += 1) {
      await agent.client.sendAgentMessage(agent.agentId, `sticky prompt follow-up ${index}`);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }

    await page.setViewportSize(WIDE_VIEWPORT);
    await openAgentTimeline(page, agent);
    await scrollPromptToActualTop(page, longPrompt);

    const sticky = page.getByTestId("sticky-prompt");
    const text = sticky.getByTestId("sticky-prompt-text");
    const toggle = sticky.getByTestId("sticky-prompt-toggle");
    await expect(toggle).toHaveAccessibleName("Show more");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");

    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Show less");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(text).toContainText(longPrompt);
    const expanded = await sticky.boundingBox();
    expect(expanded?.height).toBeLessThan(300);
    await page.screenshot({ path: test.info().outputPath("expanded-question.png") });

    await toggle.click();
    await expect(toggle).toHaveAccessibleName("Show more");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
  } finally {
    await agent.cleanup();
  }
});
