import React, { memo, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import type { StickyPromptItem, StickyPromptSource } from "./model";
import { STICKY_PROMPT_COLLAPSE_LINE_LIMIT, shouldCollapseStickyPrompt } from "./model";

export interface StickyPromptViewProps {
  items: readonly StickyPromptItem[];
  source: StickyPromptSource;
  isMobileBreakpoint: boolean;
}

export const StickyPrompt = memo(function StickyPrompt({
  items,
  source,
  isMobileBreakpoint,
}: StickyPromptViewProps) {
  const { t } = useTranslation();
  const activePromptId = useSyncExternalStore(
    source.subscribe,
    source.getActivePromptId,
    source.getActivePromptId,
  );
  const prompt = useMemo(
    () => items.find((item) => item.id === activePromptId && item.text.trim().length > 0) ?? null,
    [activePromptId, items],
  );
  const [expandedPromptId, setExpandedPromptId] = useState<string | null>(null);
  const promptId = prompt?.id ?? null;
  const isLong = prompt ? shouldCollapseStickyPrompt(prompt.text) : false;
  const isExpanded = promptId !== null && expandedPromptId === promptId;
  const toggleLabel = isExpanded
    ? t("sidebar.workspace.actions.showLess")
    : t("sidebar.workspace.actions.showMore");
  const handleToggle = useCallback(() => {
    if (!promptId) {
      return;
    }
    setExpandedPromptId(isExpanded ? null : promptId);
  }, [isExpanded, promptId]);

  if (!prompt) {
    return null;
  }

  let textScrollStyle = styles.shortTextScroll;
  if (isLong) {
    textScrollStyle = styles.collapsedTextScroll;
  }
  if (isExpanded) {
    textScrollStyle = styles.expandedTextScroll;
  }

  return (
    <View style={styles.host} pointerEvents="box-none" testID="sticky-prompt">
      <View style={styles.contentRail} pointerEvents="box-none">
        <View
          style={[styles.card, isMobileBreakpoint ? styles.cardCompact : null]}
          accessibilityRole="summary"
        >
          <ScrollView
            style={textScrollStyle}
            nestedScrollEnabled
            showsVerticalScrollIndicator={isExpanded}
            testID="sticky-prompt-text-scroll"
          >
            <Text
              selectable
              style={styles.promptText}
              numberOfLines={isLong && !isExpanded ? STICKY_PROMPT_COLLAPSE_LINE_LIMIT : undefined}
              testID="sticky-prompt-text"
            >
              {prompt.text}
            </Text>
          </ScrollView>
          {isLong ? (
            <Button
              size="xs"
              variant="ghost"
              testID="sticky-prompt-toggle"
              accessibilityLabel={toggleLabel}
              aria-expanded={isExpanded}
              style={styles.toggle}
              onPress={handleToggle}
            >
              {toggleLabel}
            </Button>
          ) : null}
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: theme.colors.surface0,
  },
  contentRail: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  card: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  cardCompact: {
    paddingHorizontal: theme.spacing[2],
  },
  collapsedTextScroll: {
    flexGrow: 0,
    maxHeight: theme.fontSize.content * 1.4 * STICKY_PROMPT_COLLAPSE_LINE_LIMIT,
    overflow: "hidden",
  },
  shortTextScroll: {
    flexGrow: 0,
  },
  expandedTextScroll: {
    flexGrow: 0,
    maxHeight: 192,
  },
  promptText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    lineHeight: Math.round(theme.fontSize.content * 1.4),
  },
  toggle: {
    alignSelf: "flex-start",
  },
}));
