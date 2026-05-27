import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/500.css";
import "./App.css";
import type { DaySummary, CaptureRecord, RetrievalSearchResult, ImportBackupPayload, PerformanceSnapshotPayload, CaptureContextPagePayload, CaptureImagePayload, CaptureHealthPayload, OcrHealthPayload, ReindexCapturesPayload, CaptureErrorEventPayload, SettingsPayload, SensitiveCaptureMode, CaptureReviewPayload, ReviewShortcutCapture, ReviewShortcutsPayload, CaptureSuppressedEventPayload, PauseStatePayload, StorageStatsPayload, DeleteCapturePayload, DeleteDayPayload, NoteSaveState, ThemeId, WorkspaceMode } from "./types";
import { EMPTY_DENSITY, INTERVAL_MIN_MINUTES, INTERVAL_OPTIONS, TIMELINE_PAGE_LIMIT, TIMELINE_VIRTUAL_WINDOW, TIMELINE_THUMB_WIDTH_PX, LEGACY_THEME_ID, ONBOARDING_THEME_ID, THEME_OPTIONS } from "./constants";
import { TopBar, DayRail, ViewerPane, ReviewWorkspace, IntelligenceWorkspace, AllCapturesWorkspace, CalendarWorkspace, UtilityRail, SettingsModal, ThemeOnboardingModal, QuickStartModal, KeyboardShortcutsModal, ConfirmationModal, TimelineStrip } from "./components/app";
import { useArchiveSearch } from "./hooks/useArchiveSearch";
import { useDayIntelligence } from "./hooks/useDayIntelligence";
import { resolveThemeId, resolveSensitiveCaptureMode, parseListEditorText, listToEditorText, haveSameListValues, parseTagDraftInput, hasDismissedQuickStart, markQuickStartDismissed, themeName, dayKeyFromDate, dayDateFromKey, formatDaySecondary, formatViewerDate, formatCaptureTimestamp, isDayKey, formatCountdown, clampIntervalMinutes, fallbackDays, mergeCaptures, buildHourMarkers, deriveContextBadge } from "./utils/app";

function App() {
  const currentWindow = useMemo(() => getCurrentWindow(), []);
  const [daySummaries, setDaySummaries] = useState<DaySummary[]>([]);
  const [selectedDayKey, setSelectedDayKey] = useState<string>(() => dayKeyFromDate(new Date()));
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<number | null>(null);
  const [selectedImageDataUrl, setSelectedImageDataUrl] = useState<string | null>(null);
  const [imageCacheById, setImageCacheById] = useState<Record<number, string>>({});

  const [loadedStartOffset, setLoadedStartOffset] = useState<number>(0);
  const [loadedEndOffset, setLoadedEndOffset] = useState<number>(0);
  const [isPageLoading, setIsPageLoading] = useState<boolean>(false);

  const [isRecording, setIsRecording] = useState<boolean>(true);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(2);
  const [draftIntervalMinutes, setDraftIntervalMinutes] = useState<number>(2);
  const [isDraftIntervalCustom, setIsDraftIntervalCustom] = useState<boolean>(false);
  const [retentionDays, setRetentionDays] = useState<number>(30);
  const [storageCapGb, setStorageCapGb] = useState<number>(5);
  const [draftRetentionDays, setDraftRetentionDays] = useState<number>(30);
  const [draftStorageCapGb, setDraftStorageCapGb] = useState<number>(5);
  const [startupOnBoot, setStartupOnBoot] = useState<boolean>(false);
  const [startupOnBootSupported, setStartupOnBootSupported] = useState<boolean>(false);
  const [draftStartupOnBoot, setDraftStartupOnBoot] = useState<boolean>(false);
  const [themeId, setThemeId] = useState<ThemeId>(LEGACY_THEME_ID);
  const [draftThemeId, setDraftThemeId] = useState<ThemeId>(LEGACY_THEME_ID);
  const [excludedProcesses, setExcludedProcesses] = useState<string[]>([]);
  const [excludedWindowKeywords, setExcludedWindowKeywords] = useState<string[]>([]);
  const [pauseProcesses, setPauseProcesses] = useState<string[]>([]);
  const [pauseWindowKeywords, setPauseWindowKeywords] = useState<string[]>([]);
  const [sensitiveWindowKeywords, setSensitiveWindowKeywords] = useState<string[]>([]);
  const [sensitiveCaptureMode, setSensitiveCaptureMode] = useState<SensitiveCaptureMode>("skip");
  const [draftExcludedProcessesText, setDraftExcludedProcessesText] = useState<string>("");
  const [draftExcludedWindowKeywordsText, setDraftExcludedWindowKeywordsText] = useState<string>("");
  const [draftPauseProcessesText, setDraftPauseProcessesText] = useState<string>("");
  const [draftPauseWindowKeywordsText, setDraftPauseWindowKeywordsText] = useState<string>("");
  const [draftSensitiveWindowKeywordsText, setDraftSensitiveWindowKeywordsText] = useState<string>("");
  const [draftSensitiveCaptureMode, setDraftSensitiveCaptureMode] = useState<SensitiveCaptureMode>("skip");
  const [isThemeOnboardingOpen, setIsThemeOnboardingOpen] = useState<boolean>(false);
  const [onboardingThemeId, setOnboardingThemeId] = useState<ThemeId>(ONBOARDING_THEME_ID);
  const [isThemeOnboardingSaving, setIsThemeOnboardingSaving] = useState<boolean>(false);
  const [isQuickStartOpen, setIsQuickStartOpen] = useState<boolean>(false);
  const [isShortcutGuideOpen, setIsShortcutGuideOpen] = useState<boolean>(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("browse");

  const [storagePath, setStoragePath] = useState<string>("Resolving managed storage path...");
  const [storageStats, setStorageStats] = useState<StorageStatsPayload>({
    usedBytes: 0,
    usedGb: 0,
    storageCapGb: 5,
    usagePercent: 0,
    captureCount: 0,
  });
  const [captureHealth, setCaptureHealth] = useState<CaptureHealthPayload>({
    consecutiveFailures: 0,
    lastError: null,
  });
  const [ocrHealth, setOcrHealth] = useState<OcrHealthPayload>({
    engineAvailable: true,
    statusMessage: "",
    executablePath: null,
  });
  const [performanceSnapshot, setPerformanceSnapshot] = useState<PerformanceSnapshotPayload>({
    lastSearchMs: 0,
    lastIntelligenceMs: 0,
    searchCacheHits: 0,
    intelligenceCacheHits: 0,
  });
  const {
    activeRetrievalResultIndex,
    captureSearchQuery,
    filteredCaptures,
    isRetrievalLoading,
    normalizedSearch,
    retrievalError,
    retrievalResults,
    setActiveRetrievalResultIndex,
    setCaptureSearchQuery,
  } = useArchiveSearch({
    captures,
    onPerformanceSnapshot: setPerformanceSnapshot,
  });
  const {
    dayIntelligence,
    dayIntelligenceError,
    isDayIntelligenceLoading,
  } = useDayIntelligence({
    captureCount: captures.length,
    dayKey: selectedDayKey,
    onPerformanceSnapshot: setPerformanceSnapshot,
  });
  const [backupPassphrase, setBackupPassphrase] = useState<string>("");
  const [backupImportPath, setBackupImportPath] = useState<string>("");
  const [backupStatus, setBackupStatus] = useState<string>("");
  const [backupStatusTone, setBackupStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [isBackupBusy, setIsBackupBusy] = useState<boolean>(false);
  const [ocrReindexStatus, setOcrReindexStatus] = useState<string>("");
  const [ocrReindexStatusTone, setOcrReindexStatusTone] = useState<"neutral" | "success" | "error">("neutral");
  const [isOcrReindexBusy, setIsOcrReindexBusy] = useState<boolean>(false);
  const [maintenanceStage, setMaintenanceStage] = useState<string>("");
  const [maintenanceProgress, setMaintenanceProgress] = useState<number>(0);
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [tagDraft, setTagDraft] = useState<string>("");
  const [isReviewBusy, setIsReviewBusy] = useState<boolean>(false);
  const [reviewShortcuts, setReviewShortcuts] = useState<ReviewShortcutsPayload>({
    bookmarks: [],
    favorites: [],
    tags: [],
  });
  const [compareCaptureRef, setCompareCaptureRef] = useState<ReviewShortcutCapture | null>(null);
  const [compareImageDataUrl, setCompareImageDataUrl] = useState<string | null>(null);
  const [noteSaveState, setNoteSaveState] = useState<NoteSaveState>("idle");
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [pendingRedactionCaptureId, setPendingRedactionCaptureId] = useState<number | null>(null);
  const [pendingDeleteCaptureId, setPendingDeleteCaptureId] = useState<number | null>(null);
  const [pendingDeleteDayKey, setPendingDeleteDayKey] = useState<string | null>(null);
  const [isWindowMaximized, setIsWindowMaximized] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string>("Loading MemoryLane services...");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [clockMs, setClockMs] = useState<number>(Date.now());
  const [globalTooltip, setGlobalTooltip] = useState<{
    title: string;
    subtitle: string;
    x: number;
    y: number;
    visible: boolean;
  } | null>(null);

  const tooltipTimeoutRef = useRef<number | null>(null);

  const showDayTooltip = useCallback((e: React.MouseEvent, dayKey: string, captureCount: number) => {
    if (tooltipTimeoutRef.current !== null) {
      window.clearTimeout(tooltipTimeoutRef.current);
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const dateStr = new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(dayDateFromKey(dayKey));

    tooltipTimeoutRef.current = window.setTimeout(() => {
      setGlobalTooltip({
        title: dateStr,
        subtitle: `${captureCount} capture${captureCount === 1 ? "" : "s"} recorded`,
        x: rect.left + rect.width / 2,
        y: rect.top,
        visible: true,
      });
      tooltipTimeoutRef.current = null;
    }, 500);
  }, []);

  const hideDayTooltip = useCallback(() => {
    if (tooltipTimeoutRef.current !== null) {
      window.clearTimeout(tooltipTimeoutRef.current);
      tooltipTimeoutRef.current = null;
    }
    setGlobalTooltip((prev) => (prev ? { ...prev, visible: false } : null));
  }, []);

  useEffect(() => {
    return () => {
      if (tooltipTimeoutRef.current !== null) {
        window.clearTimeout(tooltipTimeoutRef.current);
      }
    };
  }, []);


  const selectedDayKeyRef = useRef(selectedDayKey);
  const timelineThumbRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const appliedThemeId = isThemeOnboardingOpen ? onboardingThemeId : themeId;

  useEffect(() => {
    selectedDayKeyRef.current = selectedDayKey;
  }, [selectedDayKey]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setClockMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    setDraftIntervalMinutes(intervalMinutes);
    setIsDraftIntervalCustom(!INTERVAL_OPTIONS.includes(intervalMinutes));
  }, [intervalMinutes]);

  useEffect(() => {
    setDraftRetentionDays(retentionDays);
  }, [retentionDays]);

  useEffect(() => {
    setDraftStorageCapGb(storageCapGb);
  }, [storageCapGb]);

  useEffect(() => {
    setDraftStartupOnBoot(startupOnBoot);
  }, [startupOnBoot]);

  useEffect(() => {
    setDraftThemeId(themeId);
  }, [themeId]);

  useEffect(() => {
    setDraftExcludedProcessesText(listToEditorText(excludedProcesses));
  }, [excludedProcesses]);

  useEffect(() => {
    setDraftExcludedWindowKeywordsText(listToEditorText(excludedWindowKeywords));
  }, [excludedWindowKeywords]);

  useEffect(() => {
    setDraftPauseProcessesText(listToEditorText(pauseProcesses));
  }, [pauseProcesses]);

  useEffect(() => {
    setDraftPauseWindowKeywordsText(listToEditorText(pauseWindowKeywords));
  }, [pauseWindowKeywords]);

  useEffect(() => {
    setDraftSensitiveWindowKeywordsText(listToEditorText(sensitiveWindowKeywords));
  }, [sensitiveWindowKeywords]);

  useEffect(() => {
    setDraftSensitiveCaptureMode(sensitiveCaptureMode);
  }, [sensitiveCaptureMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", appliedThemeId);
  }, [appliedThemeId]);

  useEffect(() => {
    let isMounted = true;
    let unlistenResize: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        const maximized = await currentWindow.isMaximized();
        if (isMounted) {
          setIsWindowMaximized(maximized);
        }
      } catch {}
    };

    void syncMaximizedState();

    void currentWindow
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((unlisten) => {
        unlistenResize = unlisten;
      })
      .catch(() => {
        unlistenResize = undefined;
      });

    return () => {
      isMounted = false;
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, [currentWindow]);

  const navigationDays = useMemo(
    () => (daySummaries.length > 0 ? daySummaries : fallbackDays()),
    [daySummaries],
  );

  const summaryMap = useMemo(
    () => new Map(navigationDays.map((day) => [day.dayKey, day])),
    [navigationDays],
  );

  const selectedDaySummary = useMemo(() => {
    const selectedSummary = summaryMap.get(selectedDayKey);
    if (selectedSummary) {
      return selectedSummary;
    }

    return {
      dayKey: selectedDayKey,
      captureCount: 0,
      density: [...EMPTY_DENSITY],
      firstCaptureAt: null,
      lastCaptureAt: null,
    };
  }, [selectedDayKey, summaryMap]);

  const selectedCapture = useMemo(
    () => filteredCaptures.find((capture) => capture.id === selectedCaptureId) ?? null,
    [filteredCaptures, selectedCaptureId],
  );

  const selectedCaptureIndex = useMemo(
    () => filteredCaptures.findIndex((capture) => capture.id === selectedCaptureId),
    [filteredCaptures, selectedCaptureId],
  );

  const selectedDayCaptureCount = summaryMap.get(selectedDayKey)?.captureCount ?? 0;
  const hasOlderPages = loadedStartOffset > 0;
  const hasNewerPages = loadedEndOffset < selectedDayCaptureCount;

  const virtualRange = useMemo(() => {
    if (filteredCaptures.length === 0) {
      return { start: 0, end: 0 };
    }

    if (filteredCaptures.length <= TIMELINE_VIRTUAL_WINDOW) {
      return { start: 0, end: filteredCaptures.length };
    }

    const anchor = selectedCaptureIndex >= 0 ? selectedCaptureIndex : filteredCaptures.length - 1;
    const halfWindow = Math.floor(TIMELINE_VIRTUAL_WINDOW / 2);
    const maxStart = Math.max(0, filteredCaptures.length - TIMELINE_VIRTUAL_WINDOW);
    const start = Math.max(0, Math.min(anchor - halfWindow, maxStart));
    const end = Math.min(filteredCaptures.length, start + TIMELINE_VIRTUAL_WINDOW);

    return { start, end };
  }, [filteredCaptures, selectedCaptureIndex]);

  const virtualCaptures = useMemo(
    () => filteredCaptures.slice(virtualRange.start, virtualRange.end),
    [filteredCaptures, virtualRange],
  );
  const leadingSpacerWidth = virtualRange.start * TIMELINE_THUMB_WIDTH_PX;
  const trailingSpacerWidth = (filteredCaptures.length - virtualRange.end) * TIMELINE_THUMB_WIDTH_PX;

  const todayKey = dayKeyFromDate(new Date(clockMs));
  const todaySummary = summaryMap.get(todayKey);
  const todayCaptureCount = todaySummary?.captureCount ?? 0;
  const isTodaySelected = selectedDayKey === todayKey;

  const recentDays = useMemo(() => {
    const recent = navigationDays.slice(0, 12);
    if (recent.some((day) => day.dayKey === selectedDayKey)) {
      return recent;
    }

    return [selectedDaySummary, ...recent.filter((day) => day.dayKey !== selectedDaySummary.dayKey)].slice(0, 12);
  }, [navigationDays, selectedDayKey, selectedDaySummary]);

  const nextCaptureLabel = useMemo(() => {
    const lastCaptureAt = todaySummary?.lastCaptureAt;
    if (!lastCaptureAt) {
      return `Next capture in ${intervalMinutes} min`;
    }

    const nextCaptureAt = new Date(lastCaptureAt).getTime() + intervalMinutes * 60 * 1000;
    if (Number.isNaN(nextCaptureAt)) {
      return `Next capture in ${intervalMinutes} min`;
    }

    return `Next capture in ${formatCountdown(nextCaptureAt - clockMs)}`;
  }, [clockMs, intervalMinutes, todaySummary?.lastCaptureAt]);

  const hourMarkers = useMemo(() => buildHourMarkers(filteredCaptures), [filteredCaptures]);

  const refreshStoragePath = useCallback(async () => {
    const resolvedPath = await invoke<string>("get_storage_path");
    setStoragePath(resolvedPath);
  }, []);

  const refreshSettingsAndStats = useCallback(async () => {
    const [settings, stats, health, performance, nextOcrHealth] = await Promise.all([
      invoke<SettingsPayload>("get_settings"),
      invoke<StorageStatsPayload>("get_storage_stats"),
      invoke<CaptureHealthPayload>("get_capture_health"),
      invoke<PerformanceSnapshotPayload>("get_performance_snapshot"),
      invoke<OcrHealthPayload>("get_ocr_health"),
    ]);

    setIntervalMinutes(settings.intervalMinutes);
    setRetentionDays(settings.retentionDays);
    setStorageCapGb(settings.storageCapGb);
    setIsRecording(!settings.isPaused);
    setStartupOnBoot(settings.startupOnBoot);
    setStartupOnBootSupported(settings.startupOnBootSupported);
    const trimmedTheme = settings.themeId.trim();
    const resolvedTheme = resolveThemeId(trimmedTheme);
    const needsThemeOnboarding = trimmedTheme.length === 0;
    const resolvedSensitiveMode = resolveSensitiveCaptureMode(settings.sensitiveCaptureMode);
    setThemeId(resolvedTheme);
    setExcludedProcesses(settings.excludedProcesses ?? []);
    setExcludedWindowKeywords(settings.excludedWindowKeywords ?? []);
    setPauseProcesses(settings.pauseProcesses ?? []);
    setPauseWindowKeywords(settings.pauseWindowKeywords ?? []);
    setSensitiveWindowKeywords(settings.sensitiveWindowKeywords ?? []);
    setSensitiveCaptureMode(resolvedSensitiveMode);
    setOnboardingThemeId(needsThemeOnboarding ? ONBOARDING_THEME_ID : resolvedTheme);
    setIsThemeOnboardingOpen(needsThemeOnboarding);
    if (needsThemeOnboarding) {
      setIsQuickStartOpen(false);
    } else if (!hasDismissedQuickStart()) {
      setIsQuickStartOpen(true);
    }
    setStorageStats(stats);
    setCaptureHealth(health);
    setPerformanceSnapshot(performance);
    setOcrHealth(nextOcrHealth);
  }, []);

  const refreshReviewShortcuts = useCallback(async () => {
    try {
      const payload = await invoke<ReviewShortcutsPayload>("get_review_shortcuts", {
        limit: 12,
      });
      setReviewShortcuts(payload);
    } catch {
      // Ignore shortcut refresh failures and keep existing in-memory state.
    }
  }, []);

  const fetchCapturePage = useCallback(async (dayKey: string, offset: number, limit: number) => {
    if (limit <= 0) {
      return [] as CaptureRecord[];
    }

    return invoke<CaptureRecord[]>("get_day_captures", {
      dayKey,
      offset,
      limit,
    });
  }, []);

  const initializeDayCaptures = useCallback(
    async (dayKey: string, totalCaptures: number) => {
      setIsPageLoading(true);

      try {
        if (totalCaptures <= 0) {
          setCaptures([]);
          setLoadedStartOffset(0);
          setLoadedEndOffset(0);
          setSelectedImageDataUrl(null);
          return;
        }

        const startOffset = Math.max(0, totalCaptures - TIMELINE_PAGE_LIMIT);
        const limit = Math.max(1, totalCaptures - startOffset);
        const page = await fetchCapturePage(dayKey, startOffset, limit);

        setCaptures(page);
        setLoadedStartOffset(startOffset);
        setLoadedEndOffset(startOffset + page.length);
      } finally {
        setIsPageLoading(false);
      }
    },
    [fetchCapturePage],
  );

  const refreshDaySummaries = useCallback(async (fallbackDayKey: string) => {
    const summaries = await invoke<DaySummary[]>("get_day_summaries");
    setDaySummaries(summaries);

    const nextDayKey = isDayKey(fallbackDayKey)
      ? fallbackDayKey
      : summaries[0]?.dayKey ?? dayKeyFromDate(new Date());

    setSelectedDayKey(nextDayKey);
    return { summaries, nextDayKey };
  }, []);

  const refreshAll = useCallback(
    async (fallbackDayKey: string) => {
      await Promise.all([refreshSettingsAndStats(), refreshStoragePath(), refreshReviewShortcuts()]);
      const { summaries, nextDayKey } = await refreshDaySummaries(fallbackDayKey);
      const total = summaries.find((day) => day.dayKey === nextDayKey)?.captureCount ?? 0;
      await initializeDayCaptures(nextDayKey, total);
    },
    [initializeDayCaptures, refreshDaySummaries, refreshReviewShortcuts, refreshSettingsAndStats, refreshStoragePath],
  );

  const loadOlderPage = useCallback(async () => {
    if (isPageLoading || loadedStartOffset <= 0) {
      return;
    }

    setIsPageLoading(true);

    try {
      const nextStart = Math.max(0, loadedStartOffset - TIMELINE_PAGE_LIMIT);
      const limit = loadedStartOffset - nextStart;
      const page = await fetchCapturePage(selectedDayKey, nextStart, limit);

      setCaptures((current) => mergeCaptures(page, current));
      setLoadedStartOffset(nextStart);
    } finally {
      setIsPageLoading(false);
    }
  }, [fetchCapturePage, isPageLoading, loadedStartOffset, selectedDayKey]);

  const loadNewerPage = useCallback(async () => {
    if (isPageLoading || loadedEndOffset >= selectedDayCaptureCount) {
      return;
    }

    setIsPageLoading(true);

    try {
      const remaining = selectedDayCaptureCount - loadedEndOffset;
      const limit = Math.min(TIMELINE_PAGE_LIMIT, remaining);
      const page = await fetchCapturePage(selectedDayKey, loadedEndOffset, limit);

      setCaptures((current) => mergeCaptures(current, page));
      setLoadedEndOffset((current) => current + page.length);
    } finally {
      setIsPageLoading(false);
    }
  }, [fetchCapturePage, isPageLoading, loadedEndOffset, selectedDayCaptureCount, selectedDayKey]);

  useEffect(() => {
    setSelectedCaptureId((current) => {
      if (filteredCaptures.length === 0) {
        return null;
      }

      if (current && filteredCaptures.some((capture) => capture.id === current)) {
        return current;
      }

      return filteredCaptures[filteredCaptures.length - 1].id;
    });
  }, [filteredCaptures]);

  useEffect(() => {
    setImageCacheById((current) => {
      const allowedIds = new Set(captures.map((capture) => capture.id));
      const next: Record<number, string> = {};

      for (const [captureId, dataUrl] of Object.entries(current)) {
        const numericId = Number(captureId);
        if (allowedIds.has(numericId)) {
          next[numericId] = dataUrl;
        }
      }

      return next;
    });
  }, [captures]);

  useEffect(() => {
    let disposed = false;

    if (!selectedCaptureId) {
      setSelectedImageDataUrl(null);
      return () => {
        disposed = true;
      };
    }

    const cachedImage = imageCacheById[selectedCaptureId];
    if (cachedImage) {
      setSelectedImageDataUrl(cachedImage);
      return () => {
        disposed = true;
      };
    }

    setSelectedImageDataUrl(null);

    const loadSelectedImage = async () => {
      try {
        const payload = await invoke<CaptureImagePayload>("get_capture_image", {
          captureId: selectedCaptureId,
        });

        if (!disposed) {
          setImageCacheById((current) => ({
            ...current,
            [payload.id]: payload.imageDataUrl,
          }));
          setSelectedImageDataUrl(payload.imageDataUrl);
        }
      } catch {
        if (!disposed) {
          setActionMessage("Unable to load the selected screenshot image.");
        }
      }
    };

    void loadSelectedImage();

    return () => {
      disposed = true;
    };
  }, [imageCacheById, selectedCaptureId]);

  useEffect(() => {
    let disposed = false;
    const compareCaptureId = compareCaptureRef?.captureId ?? null;

    if (!compareCaptureId || compareCaptureId === selectedCaptureId) {
      setCompareImageDataUrl(null);
      return () => {
        disposed = true;
      };
    }

    const cachedImage = imageCacheById[compareCaptureId];
    if (cachedImage) {
      setCompareImageDataUrl(cachedImage);
      return () => {
        disposed = true;
      };
    }

    setCompareImageDataUrl(null);

    const loadCompareImage = async () => {
      try {
        const payload = await invoke<CaptureImagePayload>("get_capture_image", {
          captureId: compareCaptureId,
        });

        if (!disposed) {
          setImageCacheById((current) => ({
            ...current,
            [payload.id]: payload.imageDataUrl,
          }));
          setCompareImageDataUrl(payload.imageDataUrl);
        }
      } catch {
        if (!disposed) {
          setActionMessage("Unable to load compare capture image.");
        }
      }
    };

    void loadCompareImage();

    return () => {
      disposed = true;
    };
  }, [compareCaptureRef?.captureId, imageCacheById, selectedCaptureId]);

  useEffect(() => {
    if (!selectedCapture) {
      setNoteDraft("");
      setTagDraft("");
      setNoteSaveState("idle");
      return;
    }

    setNoteDraft(selectedCapture.captureNote ?? "");
    setTagDraft(selectedCapture.tags.join(", "));
    setNoteSaveState("idle");
  }, [selectedCapture?.id, selectedCapture?.captureNote, selectedCapture?.tags]);

  useEffect(() => {
    let disposed = false;
    let unlistenCaptures: (() => void) | undefined;
    let unlistenPause: (() => void) | undefined;
    let unlistenCaptureError: (() => void) | undefined;
    let unlistenCaptureSuppressed: (() => void) | undefined;

    const bootstrap = async () => {
      setIsLoading(true);

      try {
        await refreshAll(dayKeyFromDate(new Date()));
        if (!disposed) {
          setActionMessage("Dashboard ready. Capture is running in the tray.");
        }
      } catch {
        if (!disposed) {
          setActionMessage("Backend connection unavailable. Start the app with tauri dev.");
        }
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }

      try {
        unlistenCaptures = await listen("captures-updated", async () => {
          if (!disposed) {
            await refreshAll(selectedDayKeyRef.current);
          }
        });

        unlistenPause = await listen<PauseStatePayload>("pause-state-changed", (event) => {
          if (!disposed) {
            setIsRecording(!event.payload.isPaused);
          }
        });

        unlistenCaptureError = await listen<CaptureErrorEventPayload>("capture-error", async (event) => {
          if (!disposed) {
            setActionMessage(`Capture error: ${event.payload.message}`);
            await refreshSettingsAndStats();
          }
        });

        unlistenCaptureSuppressed = await listen<CaptureSuppressedEventPayload>("capture-suppressed", async (event) => {
          if (disposed) {
            return;
          }

          const payload = event.payload;
          if (payload.mode === "pause") {
            setActionMessage(`Capture auto-paused. ${payload.reason}`);
            await refreshSettingsAndStats();
            return;
          }

          if (payload.captured) {
            setActionMessage(`Capture saved with redaction. ${payload.reason}`);
          } else {
            setActionMessage(payload.reason);
          }
        });
      } catch {
        if (!disposed) {
          setActionMessage("Live event bridge not available outside desktop runtime.");
        }
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      if (unlistenCaptures) {
        unlistenCaptures();
      }
      if (unlistenPause) {
        unlistenPause();
      }
      if (unlistenCaptureError) {
        unlistenCaptureError();
      }
      if (unlistenCaptureSuppressed) {
        unlistenCaptureSuppressed();
      }
    };
  }, [refreshAll, refreshSettingsAndStats]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const total = daySummaries.find((day) => day.dayKey === selectedDayKey)?.captureCount ?? 0;
    void initializeDayCaptures(selectedDayKey, total);
  }, [daySummaries, initializeDayCaptures, isLoading, selectedDayKey]);

  useEffect(() => {
    if (!selectedCaptureId) {
      return;
    }

    const activeThumb = timelineThumbRefs.current[selectedCaptureId];
    activeThumb?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  }, [selectedCaptureId, virtualRange.start]);

  const openCapturesFolder = useCallback(async () => {
    try {
      await invoke("open_captures_folder");
      setActionMessage("Opened managed captures directory in Explorer.");
    } catch {
      setActionMessage("Unable to open captures folder from this runtime.");
    }
  }, []);

  const triggerCaptureNow = useCallback(async () => {
    try {
      await invoke("capture_now");
      await refreshAll(selectedDayKeyRef.current);
      setActionMessage("Capture cycle completed and timeline refreshed.");
    } catch {
      setActionMessage("Capture command failed. Check screen permissions and runtime logs.");
    }
  }, [refreshAll]);

  const dismissQuickStart = useCallback((options?: { openSettings?: boolean; openShortcuts?: boolean }) => {
    markQuickStartDismissed();
    setIsQuickStartOpen(false);
    if (options?.openSettings) {
      setIsSettingsOpen(true);
    }
    if (options?.openShortcuts) {
      setIsShortcutGuideOpen(true);
    }
  }, []);

  const openBrowseWorkspace = useCallback(() => {
    setWorkspaceMode("browse");
  }, []);

  const focusSearchWorkspace = useCallback(() => {
    setWorkspaceMode("browse");
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }, []);

  const openReviewWorkspace = useCallback(() => {
    setWorkspaceMode("review");
  }, []);

  const openIntelligenceWorkspace = useCallback(() => {
    setWorkspaceMode("intelligence");
  }, []);

  const searchFromIntelligenceTerm = useCallback((term: string) => {
    setCaptureSearchQuery(term);
    setWorkspaceMode("browse");
    setActionMessage(`Filtering captures with "${term}".`);
  }, []);

  const openCaptureContext = useCallback(async (captureId: number) => {
    try {
      const payload = await invoke<CaptureContextPagePayload>("get_capture_context_page", {
        captureId,
        pageSize: TIMELINE_PAGE_LIMIT,
      });

      setSelectedDayKey(payload.dayKey);
      setCaptures(payload.captures);
      setLoadedStartOffset(payload.offset);
      setLoadedEndOffset(payload.offset + payload.captures.length);
      setSelectedCaptureId(payload.focusedCaptureId);
      return payload;
    } catch {
      return null;
    }
  }, []);

  const jumpToRetrievalResult = useCallback(async (result: RetrievalSearchResult) => {
    const payload = await openCaptureContext(result.captureId);
    if (payload) {
      setActionMessage(`Jumped to ${formatViewerDate(payload.dayKey)} at ${result.timestampLabel}.`);
    } else {
      setActionMessage("Unable to open that search result.");
    }
  }, [openCaptureContext]);

  const jumpToReviewCapture = useCallback(async (captureId: number) => {
    const payload = await openCaptureContext(captureId);
    if (payload) {
      setActionMessage(`Jumped to saved capture on ${formatViewerDate(payload.dayKey)}.`);
    } else {
      setActionMessage("Unable to open saved capture.");
    }
  }, [openCaptureContext]);

  const jumpToAllCapturesResult = useCallback(async (captureId: number) => {
    const payload = await openCaptureContext(captureId);
    if (payload) {
      setWorkspaceMode("browse");
      setActionMessage(`Jumped to capture on ${formatViewerDate(payload.dayKey)}.`);
    } else {
      setActionMessage("Unable to open capture.");
    }
  }, [openCaptureContext]);

  const jumpToCalendarDay = useCallback((dayKey: string) => {
    setSelectedDayKey(dayKey);
    setWorkspaceMode("browse");
    setActionMessage(`Opened timeline for ${formatViewerDate(dayKey)}.`);
  }, []);

  const openAllCapturesWorkspace = useCallback(() => {
    setWorkspaceMode("all-captures");
  }, []);

  const openCalendarWorkspace = useCallback(() => {
    setWorkspaceMode("calendar");
  }, []);

  const applyTagFilter = useCallback((tag: string) => {
    setCaptureSearchQuery(`tag:${tag}`);
    setActionMessage(`Filtering with tag:${tag}`);
  }, []);

  const updateCaptureReviewState = useCallback(
    async (options: { isBookmarked?: boolean; isFavorite?: boolean; tags?: string[] }, successMessage: string) => {
      if (!selectedCapture) {
        return;
      }

      setIsReviewBusy(true);
      try {
        const payload = await invoke<CaptureReviewPayload>("set_capture_review_state", {
          captureId: selectedCapture.id,
          isBookmarked: options.isBookmarked,
          isFavorite: options.isFavorite,
          tags: options.tags,
        });

        setCaptures((current) =>
          current.map((capture) =>
            capture.id === payload.captureId
              ? {
                  ...capture,
                  isBookmarked: payload.isBookmarked,
                  isFavorite: payload.isFavorite,
                  tags: payload.tags,
                }
              : capture,
          ),
        );
        setTagDraft(payload.tags.join(", "));
        await refreshReviewShortcuts();
        setActionMessage(successMessage);
      } catch {
        setActionMessage("Unable to update review state for this capture.");
      } finally {
        setIsReviewBusy(false);
      }
    },
    [refreshReviewShortcuts, selectedCapture],
  );

  const toggleBookmark = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    await updateCaptureReviewState(
      { isBookmarked: !selectedCapture.isBookmarked },
      selectedCapture.isBookmarked ? "Bookmark removed." : "Capture bookmarked.",
    );
  }, [selectedCapture, updateCaptureReviewState]);

  const toggleFavorite = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    await updateCaptureReviewState(
      { isFavorite: !selectedCapture.isFavorite },
      selectedCapture.isFavorite ? "Favorite removed." : "Capture favorited.",
    );
  }, [selectedCapture, updateCaptureReviewState]);

  const saveCaptureTags = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    const nextTags = parseTagDraftInput(tagDraft);
    await updateCaptureReviewState({ tags: nextTags }, "Capture tags saved.");
  }, [selectedCapture, tagDraft, updateCaptureReviewState]);

  const setCompareAnchor = useCallback(() => {
    if (!selectedCapture) {
      return;
    }

    setCompareCaptureRef({
      captureId: selectedCapture.id,
      dayKey: selectedCapture.dayKey,
      capturedAt: selectedCapture.capturedAt,
      timestampLabel: selectedCapture.timestampLabel,
      tags: selectedCapture.tags,
    });
    setActionMessage(`Set compare anchor to ${selectedCapture.timestampLabel}.`);
  }, [selectedCapture]);

  const clearCompareAnchor = useCallback(() => {
    setCompareCaptureRef(null);
    setCompareImageDataUrl(null);
    setActionMessage("Compare anchor cleared.");
  }, []);

  const redactSelectedCapture = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    setPendingRedactionCaptureId(selectedCapture.id);
  }, [selectedCapture]);

  const confirmRedactSelectedCapture = useCallback(async () => {
    if (!selectedCapture || pendingRedactionCaptureId !== selectedCapture.id) {
      setPendingRedactionCaptureId(null);
      return;
    }

    setPendingRedactionCaptureId(null);
    setIsReviewBusy(true);
    try {
      await invoke("redact_capture", {
        captureId: selectedCapture.id,
        redactImage: true,
        redactMetadata: true,
        clearNote: false,
      });

      await refreshAll(selectedDayKeyRef.current);
      setActionMessage("Capture redacted successfully.");
    } catch {
      setActionMessage("Unable to redact selected capture.");
    } finally {
      setIsReviewBusy(false);
    }
  }, [pendingRedactionCaptureId, refreshAll, selectedCapture]);

  const jumpThroughRetrievalResults = useCallback(
    async (step: number) => {
      if (retrievalResults.length === 0) {
        return;
      }

      const baseIndex = activeRetrievalResultIndex >= 0 ? activeRetrievalResultIndex : 0;
      const nextIndex = (baseIndex + step + retrievalResults.length) % retrievalResults.length;
      setActiveRetrievalResultIndex(nextIndex);
      await jumpToRetrievalResult(retrievalResults[nextIndex]);
    },
    [activeRetrievalResultIndex, jumpToRetrievalResult, retrievalResults],
  );

  const shiftCapture = useCallback(
    (step: number) => {
      if (filteredCaptures.length === 0) {
        return;
      }

      const baseIndex = selectedCaptureIndex >= 0 ? selectedCaptureIndex : filteredCaptures.length - 1;
      const nextIndex = Math.max(0, Math.min(filteredCaptures.length - 1, baseIndex + step));
      setSelectedCaptureId(filteredCaptures[nextIndex].id);
    },
    [filteredCaptures, selectedCaptureIndex],
  );

  const jumpToNow = useCallback(() => {
    if (!isTodaySelected || filteredCaptures.length === 0) {
      return;
    }

    setSelectedCaptureId(filteredCaptures[filteredCaptures.length - 1].id);
  }, [filteredCaptures, isTodaySelected]);

  const jumpToFirstCapture = useCallback(() => {
    if (filteredCaptures.length === 0) {
      return;
    }

    setSelectedCaptureId(filteredCaptures[0].id);
  }, [filteredCaptures]);

  const jumpToLastCapture = useCallback(() => {
    if (filteredCaptures.length === 0) {
      return;
    }

    setSelectedCaptureId(filteredCaptures[filteredCaptures.length - 1].id);
  }, [filteredCaptures]);

  const shiftDay = useCallback(
    (step: number) => {
      if (navigationDays.length === 0) {
        return;
      }

      const currentIndex = navigationDays.findIndex((day) => day.dayKey === selectedDayKey);
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = Math.max(0, Math.min(navigationDays.length - 1, baseIndex + step));
      const nextDayKey = navigationDays[nextIndex].dayKey;

      if (nextDayKey !== selectedDayKey) {
        setSelectedDayKey(nextDayKey);
      }
    },
    [navigationDays, selectedDayKey],
  );

  const jumpToToday = useCallback(async () => {
    const today = dayKeyFromDate(new Date());
    setSelectedDayKey(today);

    const total = daySummaries.find((day) => day.dayKey === today)?.captureCount ?? 0;
    await initializeDayCaptures(today, total);
  }, [daySummaries, initializeDayCaptures]);

  const toggleFullscreen = useCallback(async () => {
    try {
      const nextFullscreenState = await invoke<boolean>("toggle_fullscreen");
      setActionMessage(nextFullscreenState ? "Entered fullscreen mode." : "Exited fullscreen mode.");
    } catch {
      setActionMessage("Unable to toggle fullscreen mode.");
    }
  }, []);

  const togglePauseResume = useCallback(async () => {
    const nextPaused = isRecording;

    try {
      const payload = await invoke<PauseStatePayload>("set_pause_state", {
        isPaused: nextPaused,
      });
      setIsRecording(!payload.isPaused);
      setActionMessage(payload.isPaused ? "Capture paused from dashboard." : "Capture resumed from dashboard.");
    } catch {
      setActionMessage("Unable to update recording pause state.");
    }
  }, [isRecording]);

  const persistSettings = useCallback(async () => {
    const intervalTarget = clampIntervalMinutes(Math.round(draftIntervalMinutes || INTERVAL_MIN_MINUTES));
    const retentionTarget = Math.max(1, Math.min(365, Math.round(draftRetentionDays || 1)));
    const capTarget = Math.max(0.5, Math.min(100, Number((draftStorageCapGb || 0.5).toFixed(1))));
    const themeTarget = draftThemeId;
    const startupTarget = draftStartupOnBoot;
    const excludedProcessesTarget = parseListEditorText(draftExcludedProcessesText);
    const excludedWindowKeywordsTarget = parseListEditorText(draftExcludedWindowKeywordsText);
    const pauseProcessesTarget = parseListEditorText(draftPauseProcessesText);
    const pauseWindowKeywordsTarget = parseListEditorText(draftPauseWindowKeywordsText);
    const sensitiveWindowKeywordsTarget = parseListEditorText(draftSensitiveWindowKeywordsText);
    const sensitiveModeTarget = draftSensitiveCaptureMode;

    try {
      const updated = await invoke<SettingsPayload>("update_settings", {
        intervalMinutes: intervalTarget,
        retentionDays: retentionTarget,
        storageCapGb: capTarget,
        ...(startupOnBootSupported ? { startupOnBoot: startupTarget } : {}),
        themeId: themeTarget,
        excludedProcesses: excludedProcessesTarget,
        excludedWindowKeywords: excludedWindowKeywordsTarget,
        pauseProcesses: pauseProcessesTarget,
        pauseWindowKeywords: pauseWindowKeywordsTarget,
        sensitiveWindowKeywords: sensitiveWindowKeywordsTarget,
        sensitiveCaptureMode: sensitiveModeTarget,
      });

      setIntervalMinutes(updated.intervalMinutes);
      setRetentionDays(updated.retentionDays);
      setStorageCapGb(updated.storageCapGb);
      setStartupOnBoot(updated.startupOnBoot);
      setStartupOnBootSupported(updated.startupOnBootSupported);
      setThemeId(resolveThemeId(updated.themeId));
      setExcludedProcesses(updated.excludedProcesses ?? []);
      setExcludedWindowKeywords(updated.excludedWindowKeywords ?? []);
      setPauseProcesses(updated.pauseProcesses ?? []);
      setPauseWindowKeywords(updated.pauseWindowKeywords ?? []);
      setSensitiveWindowKeywords(updated.sensitiveWindowKeywords ?? []);
      setSensitiveCaptureMode(resolveSensitiveCaptureMode(updated.sensitiveCaptureMode));
      await refreshAll(selectedDayKeyRef.current);
      setActionMessage(
        `Settings saved. Capturing every ${updated.intervalMinutes} minute(s) with ${themeName(resolveThemeId(updated.themeId))}. Privacy mode: ${resolveSensitiveCaptureMode(updated.sensitiveCaptureMode)}.${updated.startupOnBootSupported ? ` Startup on boot ${updated.startupOnBoot ? "enabled" : "disabled"}.` : ""}`,
      );
      return true;
    } catch {
      setActionMessage("Unable to save settings.");
      return false;
    }
  }, [
    draftExcludedProcessesText,
    draftExcludedWindowKeywordsText,
    draftIntervalMinutes,
    draftPauseProcessesText,
    draftPauseWindowKeywordsText,
    draftRetentionDays,
    draftSensitiveCaptureMode,
    draftSensitiveWindowKeywordsText,
    draftStorageCapGb,
    draftThemeId,
    draftStartupOnBoot,
    refreshAll,
    startupOnBootSupported,
  ]);

  const exportEncryptedBackup = useCallback(async () => {
    if (backupPassphrase.trim().length < 8) {
      setBackupStatusTone("error");
      setBackupStatus("Passphrase must be at least 8 characters before exporting.");
      return;
    }

    setIsBackupBusy(true);
    setBackupStatusTone("neutral");
    setMaintenanceStage("Preparing encrypted backup...");
    setMaintenanceProgress(24);
    setBackupStatus("Preparing encrypted backup...");

    try {
      const path = await invoke<string>("export_encrypted_backup", {
        passphrase: backupPassphrase,
      });
      setBackupStatusTone("success");
      setMaintenanceStage("Encrypted backup complete.");
      setMaintenanceProgress(100);
      setBackupStatus(`Encrypted backup exported to ${path}`);
      setActionMessage("Encrypted backup export completed.");
    } catch {
      setBackupStatusTone("error");
      setMaintenanceStage("Encrypted backup failed.");
      setMaintenanceProgress(0);
      setBackupStatus("Backup export failed. Check passphrase and archive integrity.");
      setActionMessage("Unable to export encrypted backup.");
    } finally {
      setIsBackupBusy(false);
    }
  }, [backupPassphrase]);

  const importEncryptedBackup = useCallback(async () => {
    if (backupPassphrase.trim().length < 8) {
      setBackupStatusTone("error");
      setBackupStatus("Passphrase must be at least 8 characters before importing.");
      return;
    }

    if (backupImportPath.trim().length === 0) {
      setBackupStatusTone("error");
      setBackupStatus("Provide a .mlbk file path before importing.");
      return;
    }

    setIsBackupBusy(true);
    setBackupStatusTone("neutral");
    setMaintenanceStage("Decrypting and restoring backup...");
    setMaintenanceProgress(32);
    setBackupStatus("Decrypting and restoring backup...");

    try {
      const payload = await invoke<ImportBackupPayload>("import_encrypted_backup", {
        backupPath: backupImportPath,
        passphrase: backupPassphrase,
      });

      await refreshAll(selectedDayKeyRef.current);
      setBackupStatusTone("success");
      setMaintenanceStage("Encrypted backup restored.");
      setMaintenanceProgress(100);
      setBackupStatus(
        `Restore complete: ${payload.captureCount} captures across ${payload.dayCount} days (${formatCaptureTimestamp(payload.restoredAt)}).`,
      );
      setActionMessage("Encrypted backup restored and timeline refreshed.");
    } catch {
      setBackupStatusTone("error");
      setMaintenanceStage("Encrypted backup restore failed.");
      setMaintenanceProgress(0);
      setBackupStatus("Backup import failed. Verify file path and passphrase.");
      setActionMessage("Unable to import encrypted backup.");
    } finally {
      setIsBackupBusy(false);
    }
  }, [backupImportPath, backupPassphrase, refreshAll]);

  const reindexAllCaptures = useCallback(async () => {
    if (isOcrReindexBusy) {
      return;
    }

    setIsOcrReindexBusy(true);
    setOcrReindexStatusTone("neutral");
    setMaintenanceStage("Queueing OCR reindex job...");
    setMaintenanceProgress(20);
    setOcrReindexStatus("Queueing OCR reindex job...");

    try {
      const payload = await invoke<ReindexCapturesPayload>("reindex_all_captures");
      setOcrReindexStatusTone("success");
      setMaintenanceStage("OCR reindex job queued.");
      setMaintenanceProgress(100);
      setOcrReindexStatus(
        `Queued OCR reindex for ${payload.queuedCount} capture(s) at ${formatCaptureTimestamp(payload.queuedAt)}.`,
      );
      setActionMessage(`Queued OCR reindex for ${payload.queuedCount} capture(s).`);
      await refreshSettingsAndStats();
    } catch {
      setOcrReindexStatusTone("error");
      setMaintenanceStage("OCR reindex could not be queued.");
      setMaintenanceProgress(0);
      setOcrReindexStatus("Unable to start OCR reindex. Install Tesseract and retry.");
      setActionMessage("Unable to start OCR reindex.");
      try {
        const nextOcrHealth = await invoke<OcrHealthPayload>("get_ocr_health");
        setOcrHealth(nextOcrHealth);
      } catch {
        // Ignore OCR health refresh errors.
      }
    } finally {
      setIsOcrReindexBusy(false);
    }
  }, [isOcrReindexBusy, refreshSettingsAndStats]);

  const resetSettingsDraft = useCallback(() => {
    setDraftIntervalMinutes(intervalMinutes);
    setIsDraftIntervalCustom(!INTERVAL_OPTIONS.includes(intervalMinutes));
    setDraftThemeId(themeId);
    setDraftRetentionDays(retentionDays);
    setDraftStorageCapGb(storageCapGb);
    setDraftStartupOnBoot(startupOnBoot);
    setDraftExcludedProcessesText(listToEditorText(excludedProcesses));
    setDraftExcludedWindowKeywordsText(listToEditorText(excludedWindowKeywords));
    setDraftPauseProcessesText(listToEditorText(pauseProcesses));
    setDraftPauseWindowKeywordsText(listToEditorText(pauseWindowKeywords));
    setDraftSensitiveWindowKeywordsText(listToEditorText(sensitiveWindowKeywords));
    setDraftSensitiveCaptureMode(sensitiveCaptureMode);
  }, [
    excludedProcesses,
    excludedWindowKeywords,
    intervalMinutes,
    pauseProcesses,
    pauseWindowKeywords,
    retentionDays,
    sensitiveCaptureMode,
    sensitiveWindowKeywords,
    storageCapGb,
    themeId,
    startupOnBoot,
  ]);

  const completeThemeOnboarding = useCallback(async () => {
    if (isThemeOnboardingSaving) {
      return;
    }

    setIsThemeOnboardingSaving(true);

    try {
      const updated = await invoke<SettingsPayload>("update_settings", {
        themeId: onboardingThemeId,
      });

      const nextThemeId = resolveThemeId(updated.themeId);
      setThemeId(nextThemeId);
      setDraftThemeId(nextThemeId);
      setIsThemeOnboardingOpen(false);
      if (!hasDismissedQuickStart()) {
        setIsQuickStartOpen(true);
      }
      setActionMessage(`Theme set to ${themeName(nextThemeId)}.`);
    } catch {
      setActionMessage("Unable to save selected theme.");
    } finally {
      setIsThemeOnboardingSaving(false);
    }
  }, [isThemeOnboardingSaving, onboardingThemeId]);

  const saveSettingsFromModal = useCallback(async () => {
    const didSave = await persistSettings();
    if (didSave) {
      setIsSettingsOpen(false);
    }
  }, [persistSettings]);

  const saveCaptureNote = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    setNoteSaveState("saving");

    try {
      await invoke("update_capture_note", {
        captureId: selectedCapture.id,
        note: noteDraft,
      });

      setCaptures((current) =>
        current.map((capture) =>
          capture.id === selectedCapture.id
            ? {
                ...capture,
                captureNote: noteDraft,
              }
            : capture,
        ),
      );
      setNoteSaveState("saved");
      setActionMessage("Saved note for selected capture.");
    } catch {
      setNoteSaveState("error");
      setActionMessage("Unable to save capture note.");
    }
  }, [noteDraft, selectedCapture]);

  const copySelectedCapturePath = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    const targetPath = selectedCapture.imagePath;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(targetPath);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = targetPath;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "absolute";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }

      setActionMessage("Copied selected screenshot path.");
    } catch {
      setActionMessage("Unable to copy path from this runtime.");
    }
  }, [selectedCapture]);

  const deleteSelectedCapture = useCallback(async () => {
    if (!selectedCapture) {
      return;
    }

    setPendingDeleteCaptureId(selectedCapture.id);
  }, [selectedCapture]);

  const confirmDeleteSelectedCapture = useCallback(async () => {
    if (!selectedCapture || pendingDeleteCaptureId !== selectedCapture.id) {
      setPendingDeleteCaptureId(null);
      return;
    }

    setPendingDeleteCaptureId(null);
    try {
      const payload = await invoke<DeleteCapturePayload>("delete_capture", {
        captureId: selectedCapture.id,
      });
      if (compareCaptureRef?.captureId === selectedCapture.id) {
        clearCompareAnchor();
      }
      await refreshAll(payload.dayKey);
      setActionMessage(`Deleted capture and ${payload.removedFiles} file(s) from ${formatDaySecondary(payload.dayKey)}.`);
    } catch {
      setActionMessage("Delete capture action failed.");
    }
  }, [clearCompareAnchor, compareCaptureRef?.captureId, pendingDeleteCaptureId, refreshAll, selectedCapture]);

  const deleteSelectedDay = useCallback(async () => {
    if (selectedDaySummary.captureCount === 0) {
      setActionMessage("There are no captures to delete for this day.");
      return;
    }

    setPendingDeleteDayKey(selectedDaySummary.dayKey);
  }, [selectedDaySummary.captureCount, selectedDaySummary.dayKey]);

  const confirmDeleteSelectedDay = useCallback(async () => {
    if (selectedDaySummary.captureCount === 0 || pendingDeleteDayKey !== selectedDaySummary.dayKey) {
      setPendingDeleteDayKey(null);
      return;
    }

    setPendingDeleteDayKey(null);
    try {
      const payload = await invoke<DeleteDayPayload>("delete_day", {
        dayKey: selectedDaySummary.dayKey,
      });
      if (compareCaptureRef?.dayKey === payload.dayKey) {
        clearCompareAnchor();
      }
      await refreshAll(todayKey);
      setActionMessage(
        `Deleted ${payload.removedRows} captures and ${payload.removedFiles} files from ${formatViewerDate(payload.dayKey)}.`,
      );
    } catch {
      setActionMessage("Delete day action failed.");
    }
  }, [clearCompareAnchor, compareCaptureRef?.dayKey, pendingDeleteDayKey, refreshAll, selectedDaySummary, todayKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }

      if (isThemeOnboardingOpen) {
        return;
      }

      if (pendingRedactionCaptureId !== null || pendingDeleteCaptureId !== null || pendingDeleteDayKey !== null) {
        if (event.key === "Escape") {
          event.preventDefault();
          setPendingRedactionCaptureId(null);
          setPendingDeleteCaptureId(null);
          setPendingDeleteDayKey(null);
        }
        return;
      }

      if (isQuickStartOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          dismissQuickStart();
        }
        return;
      }

      if (isShortcutGuideOpen) {
        if (event.key === "Escape" || event.key === "?") {
          event.preventDefault();
          setIsShortcutGuideOpen(false);
        }
        return;
      }

      if (isSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsSettingsOpen(false);
        }
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(target.tagName))
      ) {
        return;
      }

      switch (event.key) {
        case "/":
          event.preventDefault();
          setWorkspaceMode("browse");
          window.requestAnimationFrame(() => {
            searchInputRef.current?.focus();
            searchInputRef.current?.select();
          });
          return;
        case "?":
          event.preventDefault();
          setIsShortcutGuideOpen(true);
          return;
        case "Escape":
          if (captureSearchQuery.trim().length > 0) {
            event.preventDefault();
            setCaptureSearchQuery("");
            setActionMessage("Cleared search query.");
          }
          return;
        case "n":
        case "N":
          if (captureSearchQuery.trim().length > 0 && retrievalResults.length > 0) {
            event.preventDefault();
            openBrowseWorkspace();
            void jumpThroughRetrievalResults(event.shiftKey ? -1 : 1);
          }
          return;
        case "r":
        case "R":
          event.preventDefault();
          openReviewWorkspace();
          setActionMessage("Switched to Review workspace.");
          return;
        case "i":
        case "I":
          event.preventDefault();
          openIntelligenceWorkspace();
          setActionMessage("Switched to Day Intelligence workspace.");
          return;
        case "v":
        case "V":
          event.preventDefault();
          openBrowseWorkspace();
          setActionMessage("Switched to Browse workspace.");
          return;
        case "ArrowLeft":
          event.preventDefault();
          shiftCapture(-1);
          return;
        case "ArrowRight":
          event.preventDefault();
          shiftCapture(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          shiftDay(-1);
          return;
        case "ArrowDown":
          event.preventDefault();
          shiftDay(1);
          return;
        case "[":
          event.preventDefault();
          shiftDay(1);
          return;
        case "]":
          event.preventDefault();
          shiftDay(-1);
          return;
        case "j":
        case "J":
          event.preventDefault();
          shiftCapture(1);
          return;
        case "k":
        case "K":
          event.preventDefault();
          shiftCapture(-1);
          return;
        case "Home":
          event.preventDefault();
          jumpToFirstCapture();
          return;
        case "End":
          event.preventDefault();
          jumpToNow();
          return;
        case "Delete":
          event.preventDefault();
          void deleteSelectedCapture();
          return;
        case "b":
        case "B":
          event.preventDefault();
          void toggleBookmark();
          return;
        case "f":
        case "F":
          event.preventDefault();
          void toggleFavorite();
          return;
        case " ":
        case "Spacebar":
          event.preventDefault();
          void togglePauseResume();
          return;
        case "c":
        case "C":
          event.preventDefault();
          void triggerCaptureNow();
          return;
        case "o":
        case "O":
          event.preventDefault();
          void openCapturesFolder();
          return;
        case "t":
        case "T":
          event.preventDefault();
          void jumpToToday();
          return;
        case "s":
        case "S":
          event.preventDefault();
          setIsSettingsOpen(true);
          return;
        case "F11":
          event.preventDefault();
          void toggleFullscreen();
          return;
        case ",":
          event.preventDefault();
          void loadOlderPage();
          return;
        case ".":
          event.preventDefault();
          void loadNewerPage();
          return;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    captureSearchQuery,
    deleteSelectedCapture,
    jumpThroughRetrievalResults,
    jumpToFirstCapture,
    jumpToNow,
    jumpToToday,
    loadNewerPage,
    loadOlderPage,
    openCapturesFolder,
    openBrowseWorkspace,
    openIntelligenceWorkspace,
    openReviewWorkspace,
    shiftCapture,
    shiftDay,
    dismissQuickStart,
    isQuickStartOpen,
    isShortcutGuideOpen,
    isThemeOnboardingOpen,
    isSettingsOpen,
    pendingDeleteCaptureId,
    pendingDeleteDayKey,
    pendingRedactionCaptureId,
    retrievalResults.length,
    toggleBookmark,
    toggleFullscreen,
    toggleFavorite,
    togglePauseResume,
    triggerCaptureNow,
  ]);

  const selectedDayIndex = navigationDays.findIndex((day) => day.dayKey === selectedDayKey);
  const hasPreviousDay = selectedDayIndex >= 0 && selectedDayIndex < navigationDays.length - 1;
  const hasNextDay = selectedDayIndex > 0;
  const selectedDayLabel = formatViewerDate(selectedDaySummary.dayKey);
  const contextBadge = deriveContextBadge(selectedCapture);
  const noteDirty = selectedCapture ? noteDraft !== selectedCapture.captureNote : false;
  const pendingDeleteDayLabel =
    pendingDeleteDayKey !== null ? formatViewerDate(pendingDeleteDayKey) : formatViewerDate(selectedDaySummary.dayKey);
  const compareCaptureLabel =
    compareCaptureRef && compareCaptureRef.captureId !== selectedCapture?.id
      ? `${formatViewerDate(compareCaptureRef.dayKey)} · ${compareCaptureRef.timestampLabel}`
      : null;

  const draftExcludedProcesses = parseListEditorText(draftExcludedProcessesText);
  const draftExcludedWindowKeywords = parseListEditorText(draftExcludedWindowKeywordsText);
  const draftPauseProcesses = parseListEditorText(draftPauseProcessesText);
  const draftPauseWindowKeywords = parseListEditorText(draftPauseWindowKeywordsText);
  const draftSensitiveKeywords = parseListEditorText(draftSensitiveWindowKeywordsText);
  const settingsDirty =
    draftIntervalMinutes !== intervalMinutes ||
    draftThemeId !== themeId ||
    draftRetentionDays !== retentionDays ||
    Number(draftStorageCapGb.toFixed(1)) !== Number(storageCapGb.toFixed(1)) ||
    draftStartupOnBoot !== startupOnBoot ||
    draftSensitiveCaptureMode !== sensitiveCaptureMode ||
    !haveSameListValues(draftExcludedProcesses, excludedProcesses) ||
    !haveSameListValues(draftExcludedWindowKeywords, excludedWindowKeywords) ||
    !haveSameListValues(draftPauseProcesses, pauseProcesses) ||
    !haveSameListValues(draftPauseWindowKeywords, pauseWindowKeywords) ||
    !haveSameListValues(draftSensitiveKeywords, sensitiveWindowKeywords);

  const handleWindowMinimize = useCallback(async () => {
    try {
      await currentWindow.minimize();
    } catch (error) {
      console.error("Failed to minimize window", error);
    }
  }, [currentWindow]);

  const handleWindowToggleMaximize = useCallback(async () => {
    try {
      await currentWindow.toggleMaximize();
      setIsWindowMaximized(await currentWindow.isMaximized());
    } catch (error) {
      console.error("Failed to toggle maximize", error);
    }
  }, [currentWindow]);

  const handleWindowClose = useCallback(async () => {
    try {
      await currentWindow.close();
    } catch (error) {
      console.error("Failed to close window", error);
    }
  }, [currentWindow]);

  return (
    <div className="memorylane-root" data-theme={appliedThemeId}>
      <div className="app-shell">
        <TopBar
          hasNextDay={hasNextDay}
          hasPreviousDay={hasPreviousDay}
          isWindowMaximized={isWindowMaximized}
          isRecording={isRecording}
          selectedDayCaptureCount={selectedDayCaptureCount}
          selectedDayKey={selectedDayKey}
          todayKey={todayKey}
          onOpenReviewWorkspace={openReviewWorkspace}
          onOpenShortcuts={() => setIsShortcutGuideOpen(true)}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onSelectDay={setSelectedDayKey}
          onSelectNextDay={() => shiftDay(-1)}
          onSelectPreviousDay={() => shiftDay(1)}
          onCloseWindow={handleWindowClose}
          onMinimizeWindow={handleWindowMinimize}
          onToggleWindowMaximize={handleWindowToggleMaximize}
        />

        <DayRail
          workspaceMode={workspaceMode}
          recentDays={recentDays}
          selectedDayKey={selectedDayKey}
          todayKey={todayKey}
          onApplyStructuredFilter={(query) => {
            setCaptureSearchQuery(query);
            setWorkspaceMode("browse");
            setActionMessage(`Applied filter: ${query}`);
            window.requestAnimationFrame(() => searchInputRef.current?.focus());
          }}
          onFocusSearch={focusSearchWorkspace}
          onOpenBrowseWorkspace={openBrowseWorkspace}
          onOpenIntelligenceWorkspace={openIntelligenceWorkspace}
          onOpenReviewWorkspace={openReviewWorkspace}
          onOpenAllCapturesWorkspace={openAllCapturesWorkspace}
          onOpenCalendarWorkspace={openCalendarWorkspace}
          onSelectDay={setSelectedDayKey}
          onShowDayTooltip={showDayTooltip}
          onHideDayTooltip={hideDayTooltip}
        />
        {workspaceMode === "browse" ? (
          <ViewerPane
            actionMessage={actionMessage}
            captureHealth={captureHealth}
            captures={filteredCaptures}
            compareCaptureLabel={compareCaptureLabel}
            compareImageDataUrl={compareImageDataUrl}
            contextBadge={contextBadge}
            isFilterActive={normalizedSearch.length > 0}
            onCaptureNow={() => void triggerCaptureNow()}
            onClearSearch={() => {
              setCaptureSearchQuery("");
              setActionMessage("Cleared search query.");
            }}
            onCopyPath={() => void copySelectedCapturePath()}
            onClearCompareAnchor={clearCompareAnchor}
            onDeleteCapture={() => void deleteSelectedCapture()}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onOpenCapturesFolder={() => void openCapturesFolder()}
            onRedactCapture={() => void redactSelectedCapture()}
            onSetCompareAnchor={setCompareAnchor}
            onSelectFirst={jumpToFirstCapture}
            onSelectLast={jumpToLastCapture}
            onSelectNext={() => shiftCapture(1)}
            onSelectPrevious={() => shiftCapture(-1)}
            onToggleFullscreen={() => void toggleFullscreen()}
            onToggleBookmark={() => void toggleBookmark()}
            onToggleFavorite={() => void toggleFavorite()}
            selectedCapture={selectedCapture}
            selectedCaptureIndex={selectedCaptureIndex}
            selectedDayLabel={selectedDayLabel}
            selectedDaySummary={selectedDaySummary}
            selectedImageDataUrl={selectedImageDataUrl}
          />
        ) : null}

        {workspaceMode === "review" ? (
          <ReviewWorkspace
            compareCaptureLabel={compareCaptureLabel}
            isReviewBusy={isReviewBusy}
            noteDirty={noteDirty}
            noteDraft={noteDraft}
            noteSaveState={noteSaveState}
            onApplyTagFilter={applyTagFilter}
            onClearCompareAnchor={clearCompareAnchor}
            onJumpToReviewCapture={(captureId) => void jumpToReviewCapture(captureId)}
            onNoteDraftChange={setNoteDraft}
            onOpenBrowseWorkspace={openBrowseWorkspace}
            onOpenIntelligenceWorkspace={openIntelligenceWorkspace}
            onRedactCapture={() => void redactSelectedCapture()}
            onSaveNote={() => void saveCaptureNote()}
            onSaveTags={() => void saveCaptureTags()}
            onSetCompareAnchor={setCompareAnchor}
            onTagDraftChange={setTagDraft}
            onToggleBookmark={() => void toggleBookmark()}
            onToggleFavorite={() => void toggleFavorite()}
            reviewShortcuts={reviewShortcuts}
            selectedCapture={selectedCapture}
            selectedDayLabel={selectedDayLabel}
            tagDraft={tagDraft}
          />
        ) : null}

        {workspaceMode === "intelligence" ? (
          <IntelligenceWorkspace
            dayIntelligence={dayIntelligence}
            dayIntelligenceError={dayIntelligenceError}
            dayIntelligenceLoading={isDayIntelligenceLoading}
            onOpenBrowseWorkspace={openBrowseWorkspace}
            onOpenReviewWorkspace={openReviewWorkspace}
            onSearchForTerm={searchFromIntelligenceTerm}
            selectedDayLabel={selectedDayLabel}
            selectedDaySummary={selectedDaySummary}
          />
        ) : null}

        {workspaceMode === "all-captures" ? (
          <AllCapturesWorkspace
            onOpenBrowseWorkspace={openBrowseWorkspace}
            onOpenReviewWorkspace={openReviewWorkspace}
            onOpenIntelligenceWorkspace={openIntelligenceWorkspace}
            onSelectCapture={(captureId) => void jumpToAllCapturesResult(captureId)}
          />
        ) : null}

        {workspaceMode === "calendar" ? (
          <CalendarWorkspace
            daySummaries={daySummaries}
            onOpenBrowseWorkspace={openBrowseWorkspace}
            onOpenReviewWorkspace={openReviewWorkspace}
            onOpenIntelligenceWorkspace={openIntelligenceWorkspace}
            onSelectDay={jumpToCalendarDay}
          />
        ) : null}

        <UtilityRail
          activeRetrievalResultIndex={activeRetrievalResultIndex}
          captureSearchQuery={captureSearchQuery}
          intervalMinutes={intervalMinutes}
          isRetrievalLoading={isRetrievalLoading}
          isRecording={isRecording}
          isJumpToNowDisabled={!isTodaySelected || filteredCaptures.length === 0}
          nextCaptureLabel={nextCaptureLabel}
          ocrHealth={ocrHealth}
          performanceSnapshot={performanceSnapshot}
          retrievalError={retrievalError}
          retrievalResults={retrievalResults}
          onCaptureNow={() => void triggerCaptureNow()}
          onDeleteDay={() => void deleteSelectedDay()}
          onOpenBrowseWorkspace={openBrowseWorkspace}
          onOpenIntelligenceWorkspace={openIntelligenceWorkspace}
          onOpenReviewWorkspace={openReviewWorkspace}
          onJumpToNow={jumpToNow}
          onSelectSearchResult={(result) => {
            const resultIndex = retrievalResults.findIndex((item) => item.captureId === result.captureId);
            if (resultIndex >= 0) {
              setActiveRetrievalResultIndex(resultIndex);
            }
            void jumpToRetrievalResult(result);
          }}
          onSearchQueryChange={setCaptureSearchQuery}
          onTogglePause={() => void togglePauseResume()}
          searchInputRef={searchInputRef}
          selectedDaySummary={selectedDaySummary}
          storageStats={storageStats}
          todayCaptureCount={todayCaptureCount}
          workspaceMode={workspaceMode}
        />

        <TimelineStrip
          captures={filteredCaptures}
          hasNewerPages={hasNewerPages}
          hasOlderPages={hasOlderPages}
          hourMarkers={hourMarkers}
          isPageLoading={isPageLoading}
          loadedEndOffset={loadedEndOffset}
          loadedStartOffset={loadedStartOffset}
          onCaptureNow={() => void triggerCaptureNow()}
          onClearSearch={() => {
            setCaptureSearchQuery("");
            setActionMessage("Cleared search query.");
          }}
          onLoadNewer={() => void loadNewerPage()}
          onLoadOlder={() => void loadOlderPage()}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onSelectCapture={setSelectedCaptureId}
          onSelectCaptureAtIndex={(index) => {
            const capture = filteredCaptures[index];
            if (capture) {
              setSelectedCaptureId(capture.id);
            }
          }}
          searchQuery={captureSearchQuery}
          selectedCaptureId={selectedCaptureId}
          selectedCaptureIndex={selectedCaptureIndex}
          selectedDayCaptureCount={selectedDayCaptureCount}
          thumbRefs={timelineThumbRefs}
          trailingSpacerWidth={trailingSpacerWidth}
          leadingSpacerWidth={leadingSpacerWidth}
          virtualCaptures={virtualCaptures}
        />
      </div>

      {isSettingsOpen ? (
        <SettingsModal
          backupImportPath={backupImportPath}
          backupPassphrase={backupPassphrase}
          backupStatus={backupStatus}
          backupStatusTone={backupStatusTone}
          draftExcludedProcessesText={draftExcludedProcessesText}
          draftExcludedWindowKeywordsText={draftExcludedWindowKeywordsText}
          draftIntervalMinutes={draftIntervalMinutes}
          draftPauseProcessesText={draftPauseProcessesText}
          draftPauseWindowKeywordsText={draftPauseWindowKeywordsText}
          draftThemeId={draftThemeId}
          draftRetentionDays={draftRetentionDays}
          draftSensitiveCaptureMode={draftSensitiveCaptureMode}
          draftSensitiveWindowKeywordsText={draftSensitiveWindowKeywordsText}
          draftStorageCapGb={draftStorageCapGb}
          draftStartupOnBoot={draftStartupOnBoot}
          isBackupBusy={isBackupBusy}
          isReindexBusy={isOcrReindexBusy}
          isCustomInterval={isDraftIntervalCustom}
          maintenanceStage={maintenanceStage}
          maintenanceProgress={maintenanceProgress}
          ocrHealth={ocrHealth}
          ocrReindexStatus={ocrReindexStatus}
          ocrReindexStatusTone={ocrReindexStatusTone}
          onBackupImportPathChange={setBackupImportPath}
          onBackupPassphraseChange={setBackupPassphrase}
          onDraftExcludedProcessesTextChange={setDraftExcludedProcessesText}
          onDraftExcludedWindowKeywordsTextChange={setDraftExcludedWindowKeywordsText}
          onEnableCustomInterval={() => setIsDraftIntervalCustom(true)}
          onClose={() => setIsSettingsOpen(false)}
          onDraftPauseProcessesTextChange={setDraftPauseProcessesText}
          onDraftPauseWindowKeywordsTextChange={setDraftPauseWindowKeywordsText}
          onDraftSensitiveCaptureModeChange={setDraftSensitiveCaptureMode}
          onDraftSensitiveWindowKeywordsTextChange={setDraftSensitiveWindowKeywordsText}
          onDraftThemeChange={setDraftThemeId}
          onDraftIntervalChange={(nextValue) => {
            setIsDraftIntervalCustom(true);
            setDraftIntervalMinutes(nextValue);
          }}
          onSelectPresetInterval={(nextValue) => {
            setIsDraftIntervalCustom(false);
            setDraftIntervalMinutes(nextValue);
          }}
          onDraftRetentionChange={setDraftRetentionDays}
          onDraftStorageCapChange={setDraftStorageCapGb}
          onDraftStartupOnBootChange={setDraftStartupOnBoot}
          onExportBackup={() => void exportEncryptedBackup()}
          onImportBackup={() => void importEncryptedBackup()}
          onReindexAllCaptures={() => void reindexAllCaptures()}
          onOpenCapturesFolder={() => void openCapturesFolder()}
          onResetDraft={resetSettingsDraft}
          onSaveSettings={() => void saveSettingsFromModal()}
          settingsDirty={settingsDirty}
          startupOnBootSupported={startupOnBootSupported}
          themeId={themeId}
          themeOptions={THEME_OPTIONS}
          storagePath={storagePath}
          storageStats={storageStats}
        />
      ) : null}

      {isThemeOnboardingOpen ? (
        <ThemeOnboardingModal
          isSaving={isThemeOnboardingSaving}
          selectedThemeId={onboardingThemeId}
          themeOptions={THEME_OPTIONS.filter((option) => option.id !== LEGACY_THEME_ID)}
          onSelectTheme={setOnboardingThemeId}
          onConfirm={() => void completeThemeOnboarding()}
        />
      ) : null}

      {!isThemeOnboardingOpen && isQuickStartOpen ? (
        <QuickStartModal
          intervalMinutes={intervalMinutes}
          onCaptureNow={() => {
            dismissQuickStart();
            void triggerCaptureNow();
          }}
          onClose={() => dismissQuickStart()}
          onOpenSettings={() => dismissQuickStart({ openSettings: true })}
          onOpenShortcuts={() => dismissQuickStart({ openShortcuts: true })}
        />
      ) : null}

      {!isThemeOnboardingOpen && !isQuickStartOpen && isShortcutGuideOpen ? (
        <KeyboardShortcutsModal
          onClose={() => setIsShortcutGuideOpen(false)}
          onOpenSettings={() => {
            setIsShortcutGuideOpen(false);
            setIsSettingsOpen(true);
          }}
        />
      ) : null}

      {pendingRedactionCaptureId !== null && selectedCapture && pendingRedactionCaptureId === selectedCapture.id ? (
        <ConfirmationModal
          title="Redact selected capture?"
          confirmLabel={isReviewBusy ? "redacting..." : "redact capture"}
          isConfirmDisabled={isReviewBusy}
          onClose={() => setPendingRedactionCaptureId(null)}
          onConfirm={() => void confirmRedactSelectedCapture()}
          body={
            <>
              <p>
                Redact <strong>{selectedCapture.timestampLabel}</strong> and overwrite the screenshot preview with a
                redacted version.
              </p>
              <p>This also updates the capture metadata while keeping the timeline entry in place.</p>
            </>
          }
        />
      ) : null}

      {pendingDeleteCaptureId !== null && selectedCapture && pendingDeleteCaptureId === selectedCapture.id ? (
        <ConfirmationModal
          title="Delete selected capture?"
          confirmLabel="delete capture"
          onClose={() => setPendingDeleteCaptureId(null)}
          onConfirm={() => void confirmDeleteSelectedCapture()}
          body={
            <>
              <p>
                Delete the screenshot from <strong>{selectedCapture.timestampLabel}</strong>.
              </p>
              <p>This removes the image and thumbnail files for this capture.</p>
            </>
          }
        />
      ) : null}

      {pendingDeleteDayKey !== null ? (
        <ConfirmationModal
          title="Delete selected day?"
          confirmLabel="delete day"
          onClose={() => setPendingDeleteDayKey(null)}
          onConfirm={() => void confirmDeleteSelectedDay()}
          body={
            <>
              <p>
                Delete every screenshot from <strong>{pendingDeleteDayLabel}</strong>.
              </p>
              <p>This will remove all captures for that day and cannot be undone.</p>
            </>
          }
        />
      ) : null}

      {globalTooltip && (
        <div
          className={globalTooltip.visible ? "custom-tooltip visible" : "custom-tooltip"}
          style={{
            left: `${globalTooltip.x}px`,
            top: `${globalTooltip.y}px`,
          }}
        >
          <span className="custom-tooltip-title">{globalTooltip.title}</span>
          <span className="custom-tooltip-subtitle">
            <span className="custom-tooltip-bullet" />
            {globalTooltip.subtitle}
          </span>
        </div>
      )}
    </div>
  );
}

export default App;
