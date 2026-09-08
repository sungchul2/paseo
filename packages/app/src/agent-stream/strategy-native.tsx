import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Platform,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewToken,
  type ViewStyle,
} from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { StreamItem } from "@/types/stream";
import type { Theme } from "@/styles/theme";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSettledKeyboardShift } from "@/hooks/keyboard-shift-context";
import { resolveStreamKeyboardInset } from "@/hooks/keyboard-shift-policy";
import { useRevisedHistoryRows } from "./history-row-revision";
import { useBottomAnchorController } from "./bottom-anchor-controller";
import { useScrollKeyboardDismiss } from "./scroll-keyboard-dismiss/use-scroll-keyboard-dismiss";
import type { StreamRenderInput, StreamStrategy, StreamViewportHandle } from "./strategy";
import {
  createStreamStrategy,
  isNearBottomForStreamRenderStrategy,
  resolveBottomAnchorTransportBehavior,
} from "./strategy";
import {
  abandonHistoryStartPaginationRequest,
  createHistoryStartPaginationState,
  evaluateHistoryStartPagination,
  isHistoryStartLoadingOperation,
  rearmHistoryStartPagination,
  settleHistoryStartPagination,
  type HistoryStartPaginationInput,
  type HistoryStartPaginationTransition,
} from "./history-start-pagination";
import {
  createHistoryStartSettleScheduler,
  type HistoryStartSettleScheduler,
} from "./history-start-settle-scheduler";
import {
  createStickyPromptRowIndex,
  findStickyPromptReadingRowId,
  resolveStickyPromptId,
  type StickyPromptRowPosition,
} from "./sticky-prompt/model";
import { StickyPrompt } from "./sticky-prompt/view";

const DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION = Object.freeze({
  minIndexForVisible: 0,
  autoscrollToTopThreshold: 0,
});

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const historyStartSlotStyle: ViewStyle = {
  alignItems: "center",
  justifyContent: "center",
  height: 32,
  flexShrink: 0,
};
const nativeViewportStyle: ViewStyle = {
  flex: 1,
  position: "relative",
};
const stickyPromptMeasureRowStyle: ViewStyle = {
  width: "100%",
};
const HISTORY_START_SETTLE_FRAMES = 2;

function keyExtractor(item: { id: string }): string {
  return item.id;
}

function NativeStickyPromptMeasuredRow({
  itemId,
  register,
  children,
}: {
  itemId: string;
  register: (itemId: string, node: View | null) => void;
  children: ReactNode;
}) {
  const handleRef = useCallback((node: View | null) => register(itemId, node), [itemId, register]);
  return (
    <View ref={handleRef} style={stickyPromptMeasureRowStyle}>
      {children}
    </View>
  );
}

function NativeStreamViewport(props: StreamRenderInput & { strategy: StreamStrategy }) {
  const {
    agentId,
    segments,
    historyRowRevision,
    liveHeadRowRevision,
    boundary,
    renderers,
    listEmptyComponent,
    viewportRef,
    routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    onNearBottomChange,
    stickyPrompt,
    onNearHistoryStart,
    isLoadingOlderHistory,
    hasOlderHistory,
    olderHistoryProgressKey,
    scrollEnabled,
    listStyle,
    baseListContentContainerStyle,
    strategy,
  } = props;
  const { renderHistoryMountedRow, renderLiveHeadRow, renderLiveAuxiliary } = renderers;
  const isActive = useRetainedPanelActive();
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const flatListRef = useRef<FlatList<StreamItem>>(null);
  const viewportRootRef = useRef<View>(null);
  const stickyPromptRowRefs = useRef(new Map<string, View>());
  const visibleStickyPromptRowIdsRef = useRef(new Set<string>());
  const stickyPromptMeasureFrameRef = useRef<number | null>(null);
  const stickyPromptMeasureGenerationRef = useRef(0);
  const streamViewportMetricsRef = useRef({
    containerKey: "native-virtualized",
    contentHeight: 0,
    viewportWidth: 0,
    viewportHeight: 0,
    offsetY: 0,
    viewportMeasuredForKey: null as string | null,
    contentMeasuredForKey: null as string | null,
  });
  const scrollOffsetYRef = useRef(0);
  const isUserScrollActiveRef = useRef(false);
  const scrollKeyboardDismiss = useScrollKeyboardDismiss();
  const settledKeyboardShift = useSettledKeyboardShift();
  const userScrollEndFrameIdRef = useRef<number | null>(null);
  const programmaticScrollEventBudgetRef = useRef(0);
  const [isNativeViewportSettling, setIsNativeViewportSettling] = useState(false);
  const nativeViewportSettlingFrameIdRef = useRef<number | null>(null);
  const historyStartReadyRef = useRef(false);
  const [historyStartPaginationState, setHistoryStartPaginationState] = useState(
    createHistoryStartPaginationState,
  );
  const historyStartPaginationStateRef = useRef(historyStartPaginationState);
  const historyStartSettleSchedulerRef = useRef<HistoryStartSettleScheduler | null>(null);

  const historyItems = useMemo(() => {
    if (segments.historyVirtualized.length === 0) {
      return segments.historyMounted;
    }
    return [...segments.historyVirtualized, ...segments.historyMounted];
  }, [segments.historyMounted, segments.historyVirtualized]);
  const historyRows = useRevisedHistoryRows(historyItems, historyRowRevision);
  const stickyPromptRowIndex = useMemo(() => {
    if (!stickyPrompt) {
      return null;
    }
    return createStickyPromptRowIndex({
      // FlatList data and its ListHeader are both inverted. Convert each segment back to
      // chronological order before deriving answer-to-prompt membership.
      items: [...historyItems.toReversed(), ...segments.liveHead.toReversed()],
      promptIds: stickyPrompt.items.map((item) => item.id),
    });
  }, [historyItems, segments.liveHead, stickyPrompt]);
  const registerStickyPromptRow = useCallback((itemId: string, node: View | null) => {
    if (node) {
      stickyPromptRowRefs.current.set(itemId, node);
    } else {
      stickyPromptRowRefs.current.delete(itemId);
    }
  }, []);
  const measureStickyPromptRows = useStableEvent(() => {
    if (!isActiveRef.current || !stickyPrompt || !stickyPromptRowIndex) {
      return;
    }
    const viewportRoot = viewportRootRef.current;
    if (!viewportRoot) {
      stickyPrompt.source.publish(null);
      return;
    }

    // Viewability excludes the ListHeader, so seed this with viewable rows and the live head.
    // The ref map is still bounded by FlatList's mounted window; including its current entries
    // prevents a stale viewability callback from retaining an old prompt after a jump.
    const rowIdsToMeasure = new Set(visibleStickyPromptRowIdsRef.current);
    for (const item of segments.liveHead) {
      rowIdsToMeasure.add(item.id);
    }
    for (const itemId of stickyPromptRowRefs.current.keys()) {
      rowIdsToMeasure.add(itemId);
    }

    const rows = [...rowIdsToMeasure]
      .map((itemId) => ({ itemId, node: stickyPromptRowRefs.current.get(itemId) }))
      .filter((entry): entry is { itemId: string; node: View } => entry.node !== undefined);
    const rowPositions: StickyPromptRowPosition[] = [];
    let viewportTop: number | null = null;
    const measurementGeneration = ++stickyPromptMeasureGenerationRef.current;
    const publish = () => {
      if (
        measurementGeneration !== stickyPromptMeasureGenerationRef.current ||
        !isActiveRef.current
      ) {
        return;
      }
      stickyPrompt.source.publish(
        resolveStickyPromptId({
          index: stickyPromptRowIndex,
          readingRowId:
            viewportTop === null ? null : findStickyPromptReadingRowId(rowPositions, viewportTop),
        }),
      );
    };

    let remaining = rows.length + 1;
    const finish = () => {
      if (remaining <= 0) {
        return;
      }
      remaining -= 1;
      if (remaining === 0) {
        publish();
      }
    };
    try {
      viewportRoot.measureInWindow((_left, top, width, height) => {
        if (
          Number.isFinite(top) &&
          Number.isFinite(width) &&
          Number.isFinite(height) &&
          width > 0 &&
          height > 0
        ) {
          viewportTop = top;
        }
        finish();
      });
    } catch {
      finish();
    }
    for (const { itemId, node } of rows) {
      try {
        node.measureInWindow((_left, top, _width, height) => {
          const bottom = top + height;
          if (
            Number.isFinite(top) &&
            Number.isFinite(height) &&
            height > 0 &&
            Number.isFinite(bottom)
          ) {
            rowPositions.push({ id: itemId, top, bottom });
          }
          finish();
        });
      } catch {
        finish();
      }
    }
  });
  const scheduleStickyPromptMeasurement = useStableEvent(() => {
    if (!isActiveRef.current || !stickyPrompt) {
      return;
    }
    if (stickyPromptMeasureFrameRef.current !== null) {
      return;
    }
    stickyPromptMeasureFrameRef.current = requestAnimationFrame(() => {
      stickyPromptMeasureFrameRef.current = null;
      measureStickyPromptRows();
    });
  });
  const handleStickyPromptViewableItemsChanged = useStableEvent(
    ({ viewableItems }: { viewableItems: ViewToken<StreamItem>[] }) => {
      visibleStickyPromptRowIdsRef.current = new Set(viewableItems.map(({ item }) => item.id));
      scheduleStickyPromptMeasurement();
    },
  );
  useEffect(() => {
    if (isActive) {
      scheduleStickyPromptMeasurement();
      return;
    }
    if (stickyPromptMeasureFrameRef.current !== null) {
      cancelAnimationFrame(stickyPromptMeasureFrameRef.current);
      stickyPromptMeasureFrameRef.current = null;
    }
    stickyPromptMeasureGenerationRef.current += 1;
  }, [isActive, scheduleStickyPromptMeasurement]);
  useEffect(() => {
    if (!isActive || !stickyPromptRowIndex) {
      return;
    }
    stickyPromptMeasureGenerationRef.current += 1;
    scheduleStickyPromptMeasurement();
  }, [historyRows, isActive, scheduleStickyPromptMeasurement, stickyPromptRowIndex]);
  const stickyPromptViewabilityConfig = useMemo(() => ({ itemVisiblePercentThreshold: 0 }), []);
  const getHistoryStartPaginationInput = useStableEvent((): HistoryStartPaginationInput => {
    const metrics = streamViewportMetricsRef.current;
    const hasMeasuredViewport =
      metrics.viewportMeasuredForKey === metrics.containerKey &&
      metrics.contentMeasuredForKey === metrics.containerKey;
    return {
      distanceFromHistoryStart: metrics.contentHeight - metrics.viewportHeight - metrics.offsetY,
      hasOlderHistory,
      isLoadingOlderHistory,
      isReady: historyStartReadyRef.current && hasMeasuredViewport,
      progressKey: olderHistoryProgressKey,
    };
  });
  const applyHistoryStartPaginationTransition = useStableEvent(
    (transition: HistoryStartPaginationTransition) => {
      const previousState = historyStartPaginationStateRef.current;
      historyStartPaginationStateRef.current = transition.state;
      if (transition.state !== previousState) {
        setHistoryStartPaginationState(transition.state);
      }
      if (transition.shouldLoad) {
        const requestedProgressKey = olderHistoryProgressKey;
        if (requestedProgressKey === null) {
          return;
        }
        void (async () => {
          const started = await onNearHistoryStart();
          if (started === true) {
            return;
          }
          applyHistoryStartPaginationTransition({
            state: abandonHistoryStartPaginationRequest(
              historyStartPaginationStateRef.current,
              requestedProgressKey,
            ),
            shouldLoad: false,
          });
        })();
      }
    },
  );
  const evaluateHistoryStart = useStableEvent(() => {
    const transition = evaluateHistoryStartPagination(
      historyStartPaginationStateRef.current,
      getHistoryStartPaginationInput(),
    );
    applyHistoryStartPaginationTransition(transition);
  });
  const scheduleHistoryStartSettle = useStableEvent(() => {
    let scheduler = historyStartSettleSchedulerRef.current;
    if (!scheduler) {
      scheduler = createHistoryStartSettleScheduler({
        settleFrames: HISTORY_START_SETTLE_FRAMES,
        requestFrame: requestAnimationFrame,
        cancelFrame: cancelAnimationFrame,
        isSettling: () => historyStartPaginationStateRef.current.status === "settling",
        isLoading: () => getHistoryStartPaginationInput().isLoadingOlderHistory,
        onSettle: () => {
          const transition = settleHistoryStartPagination(
            historyStartPaginationStateRef.current,
            getHistoryStartPaginationInput(),
          );
          applyHistoryStartPaginationTransition(transition);
        },
      });
      historyStartSettleSchedulerRef.current = scheduler;
    }
    scheduler.schedule();
  });

  const clearNativeViewportSettling = useCallback(() => {
    if (nativeViewportSettlingFrameIdRef.current !== null) {
      cancelAnimationFrame(nativeViewportSettlingFrameIdRef.current);
      nativeViewportSettlingFrameIdRef.current = null;
    }
  }, []);

  const clearPendingUserScrollEnd = useCallback(() => {
    if (userScrollEndFrameIdRef.current !== null) {
      cancelAnimationFrame(userScrollEndFrameIdRef.current);
      userScrollEndFrameIdRef.current = null;
    }
  }, []);

  const markNativeViewportSettling = useCallback(() => {
    clearNativeViewportSettling();
    setIsNativeViewportSettling(true);
    let remainingFrames = 4;
    const tick = () => {
      if (remainingFrames <= 0) {
        nativeViewportSettlingFrameIdRef.current = null;
        setIsNativeViewportSettling(false);
        return;
      }
      remainingFrames -= 1;
      nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
    };
    nativeViewportSettlingFrameIdRef.current = requestAnimationFrame(tick);
  }, [clearNativeViewportSettling]);

  const bottomAnchorTransportBehavior = useMemo(
    () =>
      resolveBottomAnchorTransportBehavior({
        strategy,
        isViewportSettling: isNativeViewportSettling,
      }),
    [isNativeViewportSettling, strategy],
  );

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      programmaticScrollEventBudgetRef.current = 3;
      flatListRef.current?.scrollToOffset({
        offset: 0,
        animated,
      });
      scrollOffsetYRef.current = 0;
      streamViewportMetricsRef.current = {
        ...streamViewportMetricsRef.current,
        offsetY: 0,
      };
      onNearBottomChange(true);
    },
    [onNearBottomChange],
  );

  const bottomAnchorController = useBottomAnchorController({
    agentId,
    routeRequest: routeBottomAnchorRequest,
    isAuthoritativeHistoryReady,
    renderStrategy: "inverted-stream",
    transportBehavior: bottomAnchorTransportBehavior,
    getMeasurementState: () => streamViewportMetricsRef.current,
    isNearBottom: () => {
      const metrics = streamViewportMetricsRef.current;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: metrics.offsetY,
        threshold: 32,
        contentHeight: metrics.contentHeight,
        viewportHeight: metrics.viewportHeight,
      });
    },
    scrollToBottom,
  });
  // Android's maintainVisibleContentPosition ignores the list inversion transform and
  // fights the controller's offset-zero correction while the live header grows.
  const maintainVisibleContentPosition =
    Platform.OS === "android" && bottomAnchorController.mode === "sticky-bottom"
      ? undefined
      : DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION;
  const streamKeyboardInset = useMemo(
    () =>
      resolveStreamKeyboardInset({
        platform: Platform.OS === "ios" ? "ios" : "android",
        settledShift: settledKeyboardShift,
      }),
    [settledKeyboardShift],
  );
  const listContentContainerStyle = useMemo(
    () => [
      baseListContentContainerStyle,
      { paddingBottom: streamKeyboardInset.contentContainerPaddingBottom },
    ],
    [baseListContentContainerStyle, streamKeyboardInset.contentContainerPaddingBottom],
  );
  const listInsetProps = useMemo(
    () =>
      streamKeyboardInset.contentInset
        ? {
            automaticallyAdjustContentInsets: false,
            automaticallyAdjustsScrollIndicatorInsets: false,
            contentInsetAdjustmentBehavior: "never" as const,
            contentInset: streamKeyboardInset.contentInset,
            scrollIndicatorInsets: streamKeyboardInset.contentInset,
          }
        : {},
    [streamKeyboardInset.contentInset],
  );

  useEffect(() => {
    streamViewportMetricsRef.current = {
      containerKey: "native-virtualized",
      contentHeight: 0,
      viewportWidth: 0,
      viewportHeight: 0,
      offsetY: 0,
      viewportMeasuredForKey: null,
      contentMeasuredForKey: null,
    };
    scrollOffsetYRef.current = 0;
    isUserScrollActiveRef.current = false;
    clearPendingUserScrollEnd();
    clearNativeViewportSettling();
    if (stickyPromptMeasureFrameRef.current !== null) {
      cancelAnimationFrame(stickyPromptMeasureFrameRef.current);
      stickyPromptMeasureFrameRef.current = null;
    }
    setIsNativeViewportSettling(false);
    historyStartReadyRef.current = false;
    const initialHistoryStartState = createHistoryStartPaginationState();
    historyStartPaginationStateRef.current = initialHistoryStartState;
    setHistoryStartPaginationState(initialHistoryStartState);
    const frame = requestAnimationFrame(() => {
      historyStartReadyRef.current = true;
      evaluateHistoryStart();
      scheduleStickyPromptMeasurement();
    });
    return () => {
      cancelAnimationFrame(frame);
      clearPendingUserScrollEnd();
      if (stickyPromptMeasureFrameRef.current !== null) {
        cancelAnimationFrame(stickyPromptMeasureFrameRef.current);
        stickyPromptMeasureFrameRef.current = null;
      }
      stickyPromptMeasureGenerationRef.current += 1;
      historyStartSettleSchedulerRef.current?.cancel();
      historyStartSettleSchedulerRef.current = null;
    };
  }, [
    agentId,
    clearNativeViewportSettling,
    clearPendingUserScrollEnd,
    evaluateHistoryStart,
    scheduleStickyPromptMeasurement,
  ]);

  useEffect(() => () => clearNativeViewportSettling(), [clearNativeViewportSettling]);

  useEffect(() => {
    bottomAnchorController.prepareForStickyContentChange();
  }, [bottomAnchorController, historyRows, segments.liveHead]);

  useEffect(() => {
    const handle: StreamViewportHandle = {
      scrollToBottom: (reason = "jump-to-bottom") => {
        bottomAnchorController.requestLocalAnchor({
          agentId,
          reason,
        });
      },
      prepareForViewportChange: () => {
        bottomAnchorController.prepareForStickyViewportChange();
        markNativeViewportSettling();
      },
    };
    viewportRef.current = handle;
    return () => {
      if (viewportRef.current === handle) {
        viewportRef.current = null;
      }
    };
  }, [agentId, bottomAnchorController, markNativeViewportSettling, viewportRef]);

  const isScrollEventNearBottom = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      return isNearBottomForStreamRenderStrategy({
        strategy,
        offsetY: contentOffset.y,
        threshold: 32,
        contentHeight: contentSize.height,
        viewportHeight: layoutMeasurement.height,
      });
    },
  );

  const handleScroll = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const previousOffsetY = scrollOffsetYRef.current;
    scrollOffsetYRef.current = contentOffset.y;
    scrollKeyboardDismiss.onScroll(event);

    streamViewportMetricsRef.current = {
      contentHeight: Math.max(0, contentSize.height),
      viewportWidth: Math.max(0, layoutMeasurement.width),
      viewportHeight: Math.max(0, layoutMeasurement.height),
      containerKey: "native-virtualized",
      offsetY: contentOffset.y,
      viewportMeasuredForKey: "native-virtualized",
      contentMeasuredForKey: "native-virtualized",
    };

    const nearBottom = isScrollEventNearBottom(event);
    onNearBottomChange(nearBottom);

    evaluateHistoryStart();
    scheduleStickyPromptMeasurement();

    if (
      !isUserScrollActiveRef.current &&
      programmaticScrollEventBudgetRef.current > 0 &&
      contentOffset.y <= 8
    ) {
      programmaticScrollEventBudgetRef.current -= 1;
    } else {
      programmaticScrollEventBudgetRef.current = 0;
      bottomAnchorController.handleScrollNearBottomChange({
        nextIsNearBottom: nearBottom,
        scrollDelta: contentOffset.y - previousOffsetY,
      });
    }
  });

  const handleScrollBeginDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    clearPendingUserScrollEnd();
    isUserScrollActiveRef.current = true;
    scrollKeyboardDismiss.onScrollBeginDrag(event);
    bottomAnchorController.beginUserScroll();
    const rearmed = rearmHistoryStartPagination(historyStartPaginationStateRef.current);
    if (rearmed !== historyStartPaginationStateRef.current) {
      historyStartPaginationStateRef.current = rearmed;
      setHistoryStartPaginationState(rearmed);
      evaluateHistoryStart();
    }
  });

  // Defer drag end so momentum can take ownership, but capture the terminal
  // gesture position now because layout may move the viewport in the meantime.
  const handleScrollEndDrag = useStableEvent((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const isNearBottom = isScrollEventNearBottom(event);
    scrollKeyboardDismiss.onScrollEndDrag(event);

    clearPendingUserScrollEnd();
    userScrollEndFrameIdRef.current = requestAnimationFrame(() => {
      userScrollEndFrameIdRef.current = null;
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    });
  });

  const handleMomentumScrollBegin = useStableEvent(() => {
    clearPendingUserScrollEnd();
  });

  const handleMomentumScrollEnd = useStableEvent(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Android can emit momentum-end after a programmatic anchor correction.
      // Only momentum that still owns the user gesture may settle scroll intent.
      if (!isUserScrollActiveRef.current) {
        return;
      }
      const isNearBottom = isScrollEventNearBottom(event);
      clearPendingUserScrollEnd();
      isUserScrollActiveRef.current = false;
      bottomAnchorController.endUserScroll({ isNearBottom });
    },
  );

  const handleListLayout = useStableEvent((event: LayoutChangeEvent) => {
    const previousViewportWidth = streamViewportMetricsRef.current.viewportWidth;
    const previousViewportHeight = streamViewportMetricsRef.current.viewportHeight;
    const viewportWidth = Math.max(0, event.nativeEvent.layout.width);
    const viewportHeight = Math.max(0, event.nativeEvent.layout.height);
    const viewportChanged =
      (previousViewportWidth > 0 && previousViewportWidth !== viewportWidth) ||
      (previousViewportHeight > 0 && previousViewportHeight !== viewportHeight);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      viewportWidth,
      viewportHeight,
      viewportMeasuredForKey: "native-virtualized",
    };
    if (viewportChanged) {
      markNativeViewportSettling();
    }
    bottomAnchorController.handleViewportMetricsChange({
      previousViewportWidth,
      viewportWidth,
      previousViewportHeight,
      viewportHeight,
    });
    evaluateHistoryStart();
    scheduleStickyPromptMeasurement();
  });

  const handleContentSizeChange = useStableEvent((_width: number, height: number) => {
    const previousContentHeight = streamViewportMetricsRef.current.contentHeight;
    const nextContentHeight = Math.max(0, height);
    streamViewportMetricsRef.current = {
      ...streamViewportMetricsRef.current,
      containerKey: "native-virtualized",
      contentHeight: nextContentHeight,
      contentMeasuredForKey: "native-virtualized",
    };
    bottomAnchorController.handleContentSizeChange({
      previousContentHeight,
      contentHeight: nextContentHeight,
    });
    evaluateHistoryStart();
    scheduleStickyPromptMeasurement();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  });

  useEffect(() => {
    evaluateHistoryStart();
    scheduleStickyPromptMeasurement();
    if (historyStartPaginationStateRef.current.status === "settling") {
      scheduleHistoryStartSettle();
    }
  }, [
    evaluateHistoryStart,
    hasOlderHistory,
    isLoadingOlderHistory,
    olderHistoryProgressKey,
    scheduleStickyPromptMeasurement,
    scheduleHistoryStartSettle,
  ]);

  const renderItem = useStableEvent(
    ({ item, index }: ListRenderItemInfo<StreamItem>): ReactElement | null => {
      const rendered = renderHistoryMountedRow(item, index, historyItems);
      return (
        <NativeStickyPromptMeasuredRow itemId={item.id} register={registerStickyPromptRow}>
          {rendered}
        </NativeStickyPromptMeasuredRow>
      );
    },
  );

  const liveHeaderContent = useMemo(() => {
    // Stable render events read the latest expansion state; this revision makes
    // the memo invoke them again when that state changes.
    void liveHeadRowRevision;
    const liveHeadRows = segments.liveHead.map((item, index) => {
      const rendered = renderLiveHeadRow(item, index, segments.liveHead);
      return (
        <NativeStickyPromptMeasuredRow
          key={item.id}
          itemId={item.id}
          register={registerStickyPromptRow}
        >
          {rendered}
        </NativeStickyPromptMeasuredRow>
      );
    });
    const liveAuxiliary = renderLiveAuxiliary();
    if (
      liveHeadRows.length === 0 &&
      !liveAuxiliary &&
      !boundary.hasMountedHistory &&
      !boundary.hasVirtualizedHistory
    ) {
      return (listEmptyComponent ?? null) as ReactElement | null;
    }
    return (
      <Fragment>
        {liveHeadRows}
        {liveAuxiliary}
      </Fragment>
    );
  }, [
    boundary,
    listEmptyComponent,
    liveHeadRowRevision,
    renderLiveAuxiliary,
    renderLiveHeadRow,
    registerStickyPromptRow,
    segments.liveHead,
  ]);

  const historyFooterContent = useMemo(() => {
    const isLoadingOperation = isHistoryStartLoadingOperation(historyStartPaginationState);
    return (
      <View style={historyStartSlotStyle} testID="older-history-slot">
        {isLoadingOperation ? (
          <View testID="load-older-history-spinner">
            <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </View>
    );
  }, [historyStartPaginationState]);

  // RN's FlatList strictMode keeps its internal renderItem wrapper stable when
  // data or the live header changes, preserving the row identities above.
  return (
    <View ref={viewportRootRef} style={[listStyle, nativeViewportStyle]} collapsable={false}>
      <FlatList
        {...listInsetProps}
        ref={flatListRef}
        data={historyRows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        strictMode
        testID="agent-chat-scroll"
        nativeID="agent-chat-scroll-native-virtualized"
        ListHeaderComponent={liveHeaderContent ?? undefined}
        ListFooterComponent={historyFooterContent ?? undefined}
        contentContainerStyle={listContentContainerStyle}
        style={listStyle}
        onLayout={handleListLayout}
        onScroll={handleScroll}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        scrollEventThrottle={16}
        onContentSizeChange={handleContentSizeChange}
        onViewableItemsChanged={handleStickyPromptViewableItemsChanged}
        viewabilityConfig={stickyPromptViewabilityConfig}
        maintainVisibleContentPosition={maintainVisibleContentPosition}
        initialNumToRender={12}
        windowSize={10}
        removeClippedSubviews={false}
        scrollEnabled={scrollEnabled}
        showsVerticalScrollIndicator
        inverted
      />
      {stickyPrompt ? <StickyPrompt {...stickyPrompt} /> : null}
    </View>
  );
}

export function createNativeStreamStrategy(): StreamStrategy {
  const strategy = createStreamStrategy({
    render: (renderInput) => <NativeStreamViewport {...renderInput} strategy={strategy} />,
    orderTailReverse: true,
    orderHeadReverse: true,
    assistantTurnTraversalStep: 1,
    edgeSlot: "header",
    historyLiveBoundaryEdge: "first",
    liveHeadHistoryBoundaryEdge: "last",
    frameChildOrder: "footer-then-content",
    flatListInverted: true,
    overlayScrollbarInverted: true,
    maintainVisibleContentPosition: DEFAULT_MAINTAIN_VISIBLE_CONTENT_POSITION,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 2,
      verificationRetryMode: "recheck",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: true,
    useVirtualizedList: true,
    isNearBottom: (input) => input.offsetY <= input.threshold,
    getBottomOffset: () => 0,
  });
  return strategy;
}
