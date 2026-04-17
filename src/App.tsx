import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type DaySummary = {
  dayKey: string;
  captureCount: number;
  density: number[];
  firstCaptureAt: string | null;
  lastCaptureAt: string | null;
};

type DayCapture = {
  id: number;
  dayKey: string;
  capturedAt: string;
  timestampLabel: string;
  imagePath: string;
  thumbnailDataUrl: string;
};

type CaptureImagePayload = {
  id: number;
  imageDataUrl: string;
};

type CaptureHealthPayload = {
  consecutiveFailures: number;
  lastError: string | null;
};

type CaptureErrorEventPayload = {
  message: string;
};

type SettingsPayload = {
  intervalMinutes: number;
  retentionDays: number;
  storageCapGb: number;
  isPaused: boolean;
  startupOnBoot: boolean;
  startupOnBootSupported: boolean;
};

type PauseStatePayload = {
  isPaused: boolean;
};

type StorageStatsPayload = {
  usedBytes: number;
  usedGb: number;
  storageCapGb: number;
  usagePercent: number;
  captureCount: number;
};

type DeleteCapturePayload = {
  captureId: number;
  dayKey: string;
  removedFiles: number;
};

const HOUR_MARKERS = ["9 AM", "10 AM", "11 AM", "12 PM", "1 PM", "2 PM", "3 PM", "4 PM", "5 PM", "6 PM"];
const DISPLAY_FILTERS = ["All captures", "Morning", "Afternoon", "Evening"];
const EMPTY_DENSITY = [0.1, 0.12, 0.16, 0.2, 0.18, 0.14, 0.12, 0.08];
const TIMELINE_PAGE_LIMIT = 240;
const TIMELINE_VIRTUAL_WINDOW = 72;
const TIMELINE_THUMB_WIDTH_PX = 112;

function dayKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dayDateFromKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function formatDayLabel(dayKey: string): string {
  const dayDate = dayDateFromKey(dayKey);
  const today = dayKeyFromDate(new Date());
  const yesterday = dayKeyFromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

  if (dayKey === today) {
    return "Today";
  }

  if (dayKey === yesterday) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(dayDate);
}

function formatDaySecondary(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(dayDateFromKey(dayKey));
}

function formatViewerDate(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dayDateFromKey(dayKey));
}

function captureHour(capture: DayCapture): number {
  const parsed = new Date(capture.capturedAt);
  if (Number.isNaN(parsed.getTime())) {
    return 0;
  }
  return parsed.getHours();
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tagName = target.tagName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || tagName === "option";
}

function fallbackDays(): DaySummary[] {
  const days: DaySummary[] = [];

  for (let index = 0; index < 5; index += 1) {
    const date = new Date(Date.now() - index * 24 * 60 * 60 * 1000);
    days.push({
      dayKey: dayKeyFromDate(date),
      captureCount: 0,
      density: [...EMPTY_DENSITY],
      firstCaptureAt: null,
      lastCaptureAt: null,
    });
  }

  return days;
}

function mergeCaptures(existing: DayCapture[], incoming: DayCapture[]): DayCapture[] {
  const mergedMap = new Map<number, DayCapture>();

  for (const capture of existing) {
    mergedMap.set(capture.id, capture);
  }

  for (const capture of incoming) {
    mergedMap.set(capture.id, capture);
  }

  return Array.from(mergedMap.values()).sort(
    (left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime(),
  );
}

function App() {
  const [daySummaries, setDaySummaries] = useState<DaySummary[]>([]);
  const [selectedDayKey, setSelectedDayKey] = useState<string>(() => dayKeyFromDate(new Date()));
  const [captures, setCaptures] = useState<DayCapture[]>([]);
  const [selectedCaptureId, setSelectedCaptureId] = useState<number | null>(null);
  const [selectedImageDataUrl, setSelectedImageDataUrl] = useState<string | null>(null);
  const [imageCacheById, setImageCacheById] = useState<Record<number, string>>({});
  const [filterLabel, setFilterLabel] = useState<string>(DISPLAY_FILTERS[0]);

  const [loadedStartOffset, setLoadedStartOffset] = useState<number>(0);
  const [loadedEndOffset, setLoadedEndOffset] = useState<number>(0);
  const [isPageLoading, setIsPageLoading] = useState<boolean>(false);

  const [isRecording, setIsRecording] = useState<boolean>(true);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(2);
  const [retentionDays, setRetentionDays] = useState<number>(30);
  const [storageCapGb, setStorageCapGb] = useState<number>(5);
  const [startupOnBoot, setStartupOnBoot] = useState<boolean>(false);
  const [startupOnBootSupported, setStartupOnBootSupported] = useState<boolean>(false);

  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [draftRetentionDays, setDraftRetentionDays] = useState<number>(30);
  const [draftStorageCapGb, setDraftStorageCapGb] = useState<number>(5);

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

  const [actionMessage, setActionMessage] = useState<string>("Loading MemoryLane services...");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const selectedDayKeyRef = useRef(selectedDayKey);

  useEffect(() => {
    selectedDayKeyRef.current = selectedDayKey;
  }, [selectedDayKey]);

  useEffect(() => {
    setDraftRetentionDays(retentionDays);
  }, [retentionDays]);

  useEffect(() => {
    setDraftStorageCapGb(storageCapGb);
  }, [storageCapGb]);

  const navigationDays = useMemo(
    () => (daySummaries.length > 0 ? daySummaries : fallbackDays()),
    [daySummaries],
  );

  const selectedDaySummary = navigationDays.find((day) => day.dayKey === selectedDayKey) ?? navigationDays[0];
  const selectedDayCaptureCount = daySummaries.find((day) => day.dayKey === selectedDayKey)?.captureCount ?? 0;

  const filteredCaptures = useMemo(() => {
    if (filterLabel === "Morning") {
      return captures.filter((capture) => captureHour(capture) < 12);
    }

    if (filterLabel === "Afternoon") {
      return captures.filter((capture) => {
        const hour = captureHour(capture);
        return hour >= 12 && hour < 17;
      });
    }

    if (filterLabel === "Evening") {
      return captures.filter((capture) => captureHour(capture) >= 17);
    }

    return captures;
  }, [captures, filterLabel]);

  const selectedCapture = useMemo(
    () => filteredCaptures.find((capture) => capture.id === selectedCaptureId) ?? null,
    [filteredCaptures, selectedCaptureId],
  );

  const selectedCaptureIndex = selectedCapture
    ? filteredCaptures.findIndex((capture) => capture.id === selectedCapture.id)
    : -1;

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

  const refreshStoragePath = useCallback(async () => {
    const resolvedPath = await invoke<string>("get_storage_path");
    setStoragePath(resolvedPath);
  }, []);

  const refreshSettingsAndStats = useCallback(async () => {
    const [settings, stats, health] = await Promise.all([
      invoke<SettingsPayload>("get_settings"),
      invoke<StorageStatsPayload>("get_storage_stats"),
      invoke<CaptureHealthPayload>("get_capture_health"),
    ]);

    setIntervalMinutes(settings.intervalMinutes);
    setRetentionDays(settings.retentionDays);
    setStorageCapGb(settings.storageCapGb);
    setIsRecording(!settings.isPaused);
    setStartupOnBoot(settings.startupOnBoot);
    setStartupOnBootSupported(settings.startupOnBootSupported);
    setStorageStats(stats);
    setCaptureHealth(health);
  }, []);

  const fetchCapturePage = useCallback(async (dayKey: string, offset: number, limit: number) => {
    if (limit <= 0) {
      return [] as DayCapture[];
    }

    return invoke<DayCapture[]>("get_day_captures", {
      dayKey,
      offset,
      limit,
    });
  }, []);

  const initializeDayCaptures = useCallback(async (dayKey: string, totalCaptures: number) => {
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
  }, [fetchCapturePage]);

  const refreshDaySummaries = useCallback(async (fallbackDayKey: string) => {
    const summaries = await invoke<DaySummary[]>("get_day_summaries");
    setDaySummaries(summaries);

    const nextDayKey = summaries.some((day) => day.dayKey === fallbackDayKey)
      ? fallbackDayKey
      : summaries[0]?.dayKey ?? dayKeyFromDate(new Date());

    setSelectedDayKey(nextDayKey);
    return { summaries, nextDayKey };
  }, []);

  const refreshAll = useCallback(async (fallbackDayKey: string) => {
    await Promise.all([refreshSettingsAndStats(), refreshStoragePath()]);
    const { summaries, nextDayKey } = await refreshDaySummaries(fallbackDayKey);
    const total = summaries.find((day) => day.dayKey === nextDayKey)?.captureCount ?? 0;
    await initializeDayCaptures(nextDayKey, total);
  }, [initializeDayCaptures, refreshDaySummaries, refreshSettingsAndStats, refreshStoragePath]);

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
    let unlistenCaptures: (() => void) | undefined;
    let unlistenPause: (() => void) | undefined;
    let unlistenCaptureError: (() => void) | undefined;

    const bootstrap = async () => {
      setIsLoading(true);
      try {
        await refreshAll(dayKeyFromDate(new Date()));
        if (!disposed) {
          setActionMessage("Tray capture is active in background.");
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
    };
  }, [refreshAll, refreshSettingsAndStats]);

  useEffect(() => {
    if (isLoading) {
      return;
    }

    const total = daySummaries.find((day) => day.dayKey === selectedDayKey)?.captureCount ?? 0;
    void initializeDayCaptures(selectedDayKey, total);
  }, [daySummaries, initializeDayCaptures, isLoading, selectedDayKey]);

  async function openCapturesFolder() {
    try {
      await invoke("open_captures_folder");
      setActionMessage("Opened managed captures directory in Explorer.");
    } catch {
      setActionMessage("Unable to open captures folder from this runtime.");
    }
  }

  async function triggerCaptureNow() {
    try {
      await invoke("capture_now");
      await refreshAll(selectedDayKeyRef.current);
      setActionMessage("Captured current screen and updated timeline.");
    } catch {
      setActionMessage("Capture command failed. Check screen permissions and runtime logs.");
    }
  }

  function shiftCapture(step: number) {
    if (filteredCaptures.length === 0) {
      return;
    }

    const baseIndex = selectedCaptureIndex >= 0 ? selectedCaptureIndex : filteredCaptures.length - 1;
    const nextIndex = Math.max(0, Math.min(filteredCaptures.length - 1, baseIndex + step));
    setSelectedCaptureId(filteredCaptures[nextIndex].id);
  }

  function jumpToNow() {
    if (filteredCaptures.length === 0) {
      return;
    }

    setSelectedCaptureId(filteredCaptures[filteredCaptures.length - 1].id);
  }

  function jumpToFirstCapture() {
    if (filteredCaptures.length === 0) {
      return;
    }

    setSelectedCaptureId(filteredCaptures[0].id);
  }

  function shiftDay(step: number) {
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
  }

  async function jumpToToday() {
    const today = dayKeyFromDate(new Date());
    setSelectedDayKey(today);

    const total = daySummaries.find((day) => day.dayKey === today)?.captureCount ?? 0;
    await initializeDayCaptures(today, total);
  }

  async function updateInterval(nextInterval: number) {
    setIntervalMinutes(nextInterval);

    try {
      const updated = await invoke<SettingsPayload>("update_settings", {
        intervalMinutes: nextInterval,
      });
      setIntervalMinutes(updated.intervalMinutes);
      setActionMessage(`Capture interval updated to ${updated.intervalMinutes} minute(s).`);
    } catch {
      setActionMessage("Unable to update capture interval.");
    }
  }

  async function togglePauseResume() {
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
  }

  async function persistRetentionSettings(nextRetentionDays?: number, nextStorageCapGb?: number) {
    const retentionTarget = Math.max(1, Math.min(365, nextRetentionDays ?? retentionDays));
    const capTarget = Math.max(0.5, Math.min(100, nextStorageCapGb ?? storageCapGb));

    try {
      const updated = await invoke<SettingsPayload>("update_settings", {
        retentionDays: retentionTarget,
        storageCapGb: capTarget,
      });

      setRetentionDays(updated.retentionDays);
      setStorageCapGb(updated.storageCapGb);
      await refreshAll(selectedDayKeyRef.current);
      setActionMessage("Retention and storage cap saved.");
    } catch {
      setActionMessage("Unable to save retention settings.");
    }
  }

  async function saveSettingsFromModal() {
    await persistRetentionSettings(draftRetentionDays, draftStorageCapGb);
    setIsSettingsOpen(false);
  }

  async function updateStartupOnBoot(enabled: boolean) {
    if (!startupOnBootSupported) {
      setActionMessage("Startup-on-boot is disabled for this build.");
      return;
    }

    const previousValue = startupOnBoot;
    setStartupOnBoot(enabled);

    try {
      const updated = await invoke<SettingsPayload>("set_startup_on_boot", {
        enabled,
      });

      setStartupOnBoot(updated.startupOnBoot);
      setStartupOnBootSupported(updated.startupOnBootSupported);
      setActionMessage(updated.startupOnBoot ? "Startup-on-boot enabled." : "Startup-on-boot disabled.");
    } catch {
      setStartupOnBoot(previousValue);
      setActionMessage("Unable to update startup-on-boot setting.");
    }
  }

  async function copySelectedCapturePath() {
    if (!selectedCapture) {
      return;
    }

    const targetPath = selectedCapture.imagePath;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
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
  }

  async function deleteSelectedCapture() {
    if (!selectedCapture) {
      return;
    }

    const shouldDelete = window.confirm(
      `Delete this screenshot from ${selectedCapture.timestampLabel}? This removes both image and thumbnail files.`,
    );

    if (!shouldDelete) {
      return;
    }

    try {
      const payload = await invoke<DeleteCapturePayload>("delete_capture", { captureId: selectedCapture.id });
      await refreshAll(payload.dayKey);
      setActionMessage(
        `Deleted capture and ${payload.removedFiles} file(s) from ${formatDaySecondary(payload.dayKey)}.`,
      );
    } catch {
      setActionMessage("Delete capture action failed.");
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (isSettingsOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsSettingsOpen(false);
        }
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) {
        return;
      }

      switch (event.key) {
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
    isSettingsOpen,
    jumpToNow,
    jumpToToday,
    loadNewerPage,
    loadOlderPage,
    openCapturesFolder,
    jumpToFirstCapture,
    shiftCapture,
    shiftDay,
    togglePauseResume,
    triggerCaptureNow,
    deleteSelectedCapture,
  ]);

  return (
    <div className="memorylane-root">
      <div className="app-shell">
        <aside className="panel sidebar-panel">
          <div className="sidebar-head">
            <div className="brand-mark" aria-hidden="true">
              ML
            </div>
            <div>
              <p className="eyebrow">Local screenshot journal</p>
              <h1>MemoryLane</h1>
            </div>
          </div>

          <p className="sidebar-title">This Week</p>

          <div className="day-list">
            {navigationDays.map((day) => {
              const isSelected = day.dayKey === selectedDayKey;

              return (
                <button
                  key={day.dayKey}
                  className={isSelected ? "day-entry selected" : "day-entry"}
                  onClick={() => setSelectedDayKey(day.dayKey)}
                >
                  <div className="day-row">
                    <span>{formatDayLabel(day.dayKey)}</span>
                    <strong>{day.captureCount}</strong>
                  </div>
                  <div className="day-meta">
                    <span>{formatDaySecondary(day.dayKey)}</span>
                    <span>{day.captureCount > 0 ? `${day.captureCount} captures` : "No captures"}</span>
                  </div>
                  <div className="density-strip" aria-hidden="true">
                    {(day.density.length > 0 ? day.density : EMPTY_DENSITY).map((value, index) => (
                      <span
                        key={`${day.dayKey}-${index}`}
                        style={{
                          height: `${8 + value * 20}px`,
                          opacity: 0.3 + value * 0.7,
                        }}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="sidebar-storage-strip">
            <div className="storage-strip-head">
              <p className="group-title">Storage</p>
              <button className="secondary compact" onClick={() => void openCapturesFolder()}>
                Open folder
              </button>
            </div>
            <div className="storage-strip-grid">
              <div>
                <span>Used</span>
                <strong>{storageStats.usedGb.toFixed(2)} GB</strong>
              </div>
              <div>
                <span>Cap</span>
                <strong>{storageStats.storageCapGb.toFixed(1)} GB</strong>
              </div>
              <div>
                <span>Total</span>
                <strong>{storageStats.captureCount} captures</strong>
              </div>
            </div>
            <div className="usage-track" role="presentation">
              <span style={{ width: `${storageStats.usagePercent}%` }} />
            </div>
          </div>
        </aside>

        <main className="panel viewer-panel">
          <header className="topbar">
            <div className="topbar-left">
              <div className={isRecording ? "status-pill recording" : "status-pill paused"}>
                {isRecording ? "Recording" : "Paused"}
              </div>

              <select
                className="topbar-filter"
                value={filterLabel}
                onChange={(event) => setFilterLabel(event.currentTarget.value)}
                aria-label="Timeline filter"
              >
                {DISPLAY_FILTERS.map((filter) => (
                  <option key={filter} value={filter}>
                    {filter}
                  </option>
                ))}
              </select>
            </div>

            <div className="topbar-actions">
              <button className="primary" onClick={() => void triggerCaptureNow()}>
                Capture now
              </button>
              <button
                className="secondary icon-btn"
                onClick={() => void togglePauseResume()}
                title={isRecording ? "Pause recording" : "Resume recording"}
                aria-label={isRecording ? "Pause recording" : "Resume recording"}
              >
                {isRecording ? (
                  <span className="icon-glyph pause" aria-hidden="true" />
                ) : (
                  <span className="icon-glyph play" aria-hidden="true" />
                )}
              </button>
              <button
                className="secondary icon-btn"
                onClick={() => setIsSettingsOpen(true)}
                title="Open settings"
                aria-label="Open settings"
              >
                <span className="icon-glyph gear" aria-hidden="true">
                  {"\u2699"}
                </span>
              </button>
            </div>
          </header>

          <div className="viewer-header">
            <div className="viewer-heading">
              <h2>{formatViewerDate(selectedDaySummary.dayKey)}</h2>
              <p>
                {filteredCaptures.length > 0
                  ? `${filteredCaptures.length} captures · ${filteredCaptures[0].timestampLabel} to ${filteredCaptures[filteredCaptures.length - 1].timestampLabel}`
                  : "No captures for this day"}
              </p>
            </div>

            <div className="viewer-nav-actions">
              <button className="secondary compact" onClick={() => shiftCapture(-1)} disabled={selectedCaptureIndex <= 0}>
                Prev
              </button>
              <button className="secondary compact" onClick={() => shiftCapture(1)} disabled={selectedCaptureIndex >= filteredCaptures.length - 1}>
                Next
              </button>
              <button className="secondary" onClick={jumpToNow} disabled={filteredCaptures.length === 0}>
                Jump to now
              </button>
              <button className="secondary compact" onClick={() => void jumpToToday()}>
                Today
              </button>
            </div>
          </div>

          {filteredCaptures.length === 0 || !selectedCapture ? (
            <section className="empty-state">
              <h3>Your timeline is quiet for now</h3>
              <p>
                MemoryLane captures your screen passively in the background. Leave it running in the tray and return
                later to scrub your day visually.
              </p>
              <div className="empty-actions">
                <button className="primary" onClick={() => void triggerCaptureNow()}>
                  Capture first screenshot now
                </button>
                <button className="secondary" onClick={() => void openCapturesFolder()}>
                  Open captures folder
                </button>
              </div>
            </section>
          ) : (
            <section className="capture-stage">
              <article className="capture-card">
                <div className="capture-image-wrap">
                  {selectedImageDataUrl ? (
                    <img
                      className="capture-image"
                      src={selectedImageDataUrl}
                      alt={`Screenshot captured at ${selectedCapture.timestampLabel}`}
                    />
                  ) : (
                    <div className="capture-image-loading">
                      <p>Loading full capture image...</p>
                    </div>
                  )}

                  <div className="viewer-overlay-actions">
                    <div className="overlay-capture-meta">
                      <h3>{selectedCapture.timestampLabel}</h3>
                      <p>Captured {new Date(selectedCapture.capturedAt).toLocaleString()}</p>
                    </div>
                    <div className="overlay-action-buttons">
                      <button className="secondary" onClick={() => void openCapturesFolder()}>
                        Open folder
                      </button>
                      <button className="secondary" onClick={() => void copySelectedCapturePath()}>
                        Copy path
                      </button>
                      <button className="danger" onClick={() => void deleteSelectedCapture()}>
                        Delete
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            </section>
          )}

          <p className="action-message">{actionMessage}</p>
          <p className="keyboard-hint">
            Shortcuts: <strong>Left/Right</strong> capture, <strong>Up/Down</strong> day, <strong>Home/End</strong> first/last, <strong>Space</strong> pause, <strong>C</strong> capture now, <strong>O</strong> open folder, <strong>T</strong> today, <strong>,/.</strong> page, <strong>Del</strong> delete, <strong>Esc</strong> close settings.
          </p>
          {captureHealth.consecutiveFailures > 0 && captureHealth.lastError ? (
            <p className="health-warning">
              Capture issues: {captureHealth.consecutiveFailures} failure(s). Last: {captureHealth.lastError}
            </p>
          ) : null}
        </main>

        <section className="panel timeline-panel">
          <div className="timeline-header">
            <div>
              <h3>Timeline</h3>
              <p>
                {filteredCaptures.length > 0
                  ? `${filteredCaptures[0].timestampLabel} to ${filteredCaptures[filteredCaptures.length - 1].timestampLabel}`
                  : "Waiting for first capture"}
              </p>
            </div>
            <p className="timeline-count">{filteredCaptures.length} screenshots</p>
          </div>

          <div className="timeline-paging">
            <button className="secondary compact" onClick={() => void loadOlderPage()} disabled={!hasOlderPages || isPageLoading}>
              Load Earlier
            </button>
            <p>
              {selectedDayCaptureCount > 0
                ? `Loaded ${loadedEndOffset > 0 ? loadedStartOffset + 1 : 0}-${loadedEndOffset} of ${selectedDayCaptureCount}`
                : "No captures in this day"}
            </p>
            <button className="secondary compact" onClick={() => void loadNewerPage()} disabled={!hasNewerPages || isPageLoading}>
              Load Later
            </button>
          </div>

          {filteredCaptures.length === 0 ? (
            <div className="timeline-empty">
              <p>No screenshots yet for this day.</p>
              <p className="muted">Keep MemoryLane running to build your visual timeline.</p>
            </div>
          ) : (
            <>
              <div className="timeline-thumbnails">
                {leadingSpacerWidth > 0 ? <div className="timeline-spacer" style={{ width: `${leadingSpacerWidth}px` }} /> : null}
                {virtualCaptures.map((capture) => (
                  <button
                    key={capture.id}
                    className={capture.id === selectedCaptureId ? "timeline-thumb active" : "timeline-thumb"}
                    onClick={() => setSelectedCaptureId(capture.id)}
                  >
                    <div className="thumb-preview" aria-hidden="true">
                      <img className="thumb-image" src={capture.thumbnailDataUrl} alt="" />
                    </div>
                    <div className="thumb-meta">
                      <span>{capture.timestampLabel}</span>
                      <strong>{formatDayLabel(capture.dayKey)}</strong>
                    </div>
                  </button>
                ))}
                {trailingSpacerWidth > 0 ? <div className="timeline-spacer" style={{ width: `${trailingSpacerWidth}px` }} /> : null}
              </div>

              <input
                className="timeline-range"
                type="range"
                min={0}
                max={filteredCaptures.length - 1}
                value={Math.max(0, selectedCaptureIndex)}
                onChange={(event) => {
                  const nextIndex = Number(event.currentTarget.value);
                  setSelectedCaptureId(filteredCaptures[nextIndex].id);
                }}
              />

              <div className="hour-markers" aria-hidden="true">
                {HOUR_MARKERS.map((marker) => (
                  <span key={marker}>{marker}</span>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {isSettingsOpen ? (
        <div className="settings-backdrop" onClick={() => setIsSettingsOpen(false)}>
          <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h3>Capture settings</h3>
              <button className="secondary compact" onClick={() => setIsSettingsOpen(false)}>
                Close
              </button>
            </div>

            <div className="settings-body">
              <section className="utility-group">
                <p className="group-title">Interval</p>
                <div className="interval-grid">
                  {[1, 2, 5, 10].map((minute) => (
                    <button
                      key={minute}
                      className={intervalMinutes === minute ? "interval-btn active" : "interval-btn"}
                      onClick={() => void updateInterval(minute)}
                    >
                      {minute} min
                    </button>
                  ))}
                </div>
              </section>

              <section className="utility-group">
                <p className="group-title">Retention</p>
                <label className="field-label" htmlFor="retention-days">
                  Keep last N days
                </label>
                <input
                  id="retention-days"
                  type="number"
                  min={1}
                  max={365}
                  value={draftRetentionDays}
                  onChange={(event) => setDraftRetentionDays(Math.max(1, Number(event.currentTarget.value) || 1))}
                />

                <label className="field-label" htmlFor="storage-cap">
                  Storage cap (GB)
                </label>
                <input
                  id="storage-cap"
                  type="number"
                  min={1}
                  max={100}
                  step={0.5}
                  value={draftStorageCapGb}
                  onChange={(event) => setDraftStorageCapGb(Math.max(0.5, Number(event.currentTarget.value) || 0.5))}
                />

                <p className="muted small">Path: {storagePath}</p>
              </section>

              <section className="utility-group">
                <p className="group-title">Startup</p>
                <label className={startupOnBootSupported ? "toggle-row" : "toggle-row disabled"}>
                  <input
                    type="checkbox"
                    checked={startupOnBoot}
                    disabled={!startupOnBootSupported}
                    onChange={(event) => void updateStartupOnBoot(event.currentTarget.checked)}
                  />
                  <span>Start MemoryLane when Windows starts</span>
                </label>
                <p className="muted small">
                  {startupOnBootSupported
                    ? "Startup toggle is available in this build."
                    : "Feature flag disabled for this build."}
                </p>
              </section>
            </div>

            <div className="settings-actions">
              <button className="secondary" onClick={() => setIsSettingsOpen(false)}>
                Cancel
              </button>
              <button className="primary" onClick={() => void saveSettingsFromModal()}>
                Save settings
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
