import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./App.css";

type DaySummary = {
  dayKey: string;
  captureCount: number;
  density: number[];
  firstCaptureAt: string | null;
  lastCaptureAt: string | null;
};

type CaptureRecord = {
  id: number;
  dayKey: string;
  capturedAt: string;
  timestampLabel: string;
  imagePath: string;
  thumbnailDataUrl: string;
  captureNote: string;
  ocrText: string;
  windowTitle: string;
  processName: string;
  isBookmarked: boolean;
  isFavorite: boolean;
  tags: string[];
  width: number;
  height: number;
};

type RetrievalSearchResult = {
  captureId: number;
  dayKey: string;
  capturedAt: string;
  timestampLabel: string;
  snippet: string;
  matchReason: string;
  matchSources: string[];
  score: number;
  snippetSource: string;
  highlightTerms: string[];
  isBookmarked: boolean;
  isFavorite: boolean;
  tags: string[];
};

type DayFocusBlock = {
  startTimestampLabel: string;
  endTimestampLabel: string;
  captureCount: number;
  dominantContext: string;
};

type DayIntelligencePayload = {
  dayKey: string;
  summary: string;
  focusBlocks: DayFocusBlock[];
  changeHighlights: string[];
  topTerms: string[];
  generatedAt: string;
  generationMs: number;
};

type ImportBackupPayload = {
  captureCount: number;
  dayCount: number;
  restoredAt: string;
};

type PerformanceSnapshotPayload = {
  lastSearchMs: number;
  lastIntelligenceMs: number;
  searchCacheHits: number;
  intelligenceCacheHits: number;
};

type CaptureContextPagePayload = {
  dayKey: string;
  totalCaptures: number;
  offset: number;
  focusedCaptureId: number;
  captures: CaptureRecord[];
};

type CaptureImagePayload = {
  id: number;
  imageDataUrl: string;
};

type CaptureHealthPayload = {
  consecutiveFailures: number;
  lastError: string | null;
};

type OcrHealthPayload = {
  engineAvailable: boolean;
  statusMessage: string;
  executablePath: string | null;
};

type ReindexCapturesPayload = {
  queuedCount: number;
  queuedAt: string;
};

type CaptureErrorEventPayload = {
  message: string;
};

type SettingsPayload = {
  intervalMinutes: number;
  retentionDays: number;
  storageCapGb: number;
  isPaused: boolean;
  themeId: string;
  excludedProcesses: string[];
  excludedWindowKeywords: string[];
  pauseProcesses: string[];
  pauseWindowKeywords: string[];
  sensitiveWindowKeywords: string[];
  sensitiveCaptureMode: string;
};

type SensitiveCaptureMode = "skip" | "redact" | "pause";

type CaptureReviewPayload = {
  captureId: number;
  isBookmarked: boolean;
  isFavorite: boolean;
  tags: string[];
};

type ReviewShortcutCapture = {
  captureId: number;
  dayKey: string;
  capturedAt: string;
  timestampLabel: string;
  tags: string[];
};

type ReviewTagShortcut = {
  tag: string;
  captureCount: number;
  latestCaptureId: number;
  latestDayKey: string;
  latestTimestampLabel: string;
};

type ReviewShortcutsPayload = {
  bookmarks: ReviewShortcutCapture[];
  favorites: ReviewShortcutCapture[];
  tags: ReviewTagShortcut[];
};

type CaptureSuppressedEventPayload = {
  mode: string;
  reason: string;
  captured: boolean;
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

type DeleteDayPayload = {
  dayKey: string;
  removedRows: number;
  removedFiles: number;
};

type NoteSaveState = "idle" | "saving" | "saved" | "error";

type ThemeId = "amber-noir" | "obsidian-jade" | "arctic-slate" | "deep-plum" | "midnight-blue";

type ThemeOption = {
  id: ThemeId;
  name: string;
  mood: string;
  swatches: [string, string, string, string];
};

type TopBarProps = {
  hasNextDay: boolean;
  hasPreviousDay: boolean;
  isWindowMaximized: boolean;
  isJumpToNowDisabled: boolean;
  isRecording: boolean;
  selectedDayCaptureCount: number;
  selectedDayKey: string;
  selectedDayLabel: string;
  todayKey: string;
  onJumpToNow: () => void;
  onOpenSettings: () => void;
  onSelectDay: (dayKey: string) => void;
  onSelectNextDay: () => void;
  onSelectPreviousDay: () => void;
  onToggleWindowMaximize: () => void;
};

type WindowControlsProps = {
  isWindowMaximized: boolean;
  onCloseWindow: () => void;
  onMinimizeWindow: () => void;
  onToggleWindowMaximize: () => void;
};

type DayRailProps = {
  recentDays: DaySummary[];
  selectedDayKey: string;
  todayKey: string;
  onJumpToToday: () => void;
  onSelectDay: (dayKey: string) => void;
};

type ViewerPaneProps = {
  actionMessage: string;
  captureHealth: CaptureHealthPayload;
  captures: CaptureRecord[];
  compareCaptureLabel: string | null;
  compareImageDataUrl: string | null;
  contextBadge: string;
  isFilterActive: boolean;
  onCopyPath: () => void;
  onClearCompareAnchor: () => void;
  onDeleteCapture: () => void;
  onOpenCapturesFolder: () => void;
  onRedactCapture: () => void;
  onSetCompareAnchor: () => void;
  onSelectNext: () => void;
  onSelectPrevious: () => void;
  onToggleBookmark: () => void;
  onToggleFavorite: () => void;
  selectedCapture: CaptureRecord | null;
  selectedCaptureIndex: number;
  selectedDayLabel: string;
  selectedDaySummary: DaySummary;
  selectedImageDataUrl: string | null;
};

type UtilityRailProps = {
  activeRetrievalResultIndex: number;
  captureSearchQuery: string;
  compareCaptureLabel: string | null;
  dayIntelligence: DayIntelligencePayload | null;
  dayIntelligenceError: string | null;
  dayIntelligenceLoading: boolean;
  intervalMinutes: number;
  isReviewBusy: boolean;
  isRetrievalLoading: boolean;
  isRecording: boolean;
  nextCaptureLabel: string;
  noteDirty: boolean;
  noteDraft: string;
  noteSaveState: NoteSaveState;
  ocrHealth: OcrHealthPayload;
  performanceSnapshot: PerformanceSnapshotPayload;
  retrievalError: string | null;
  retrievalResults: RetrievalSearchResult[];
  onCaptureNow: () => void;
  onClearCompareAnchor: () => void;
  onDeleteDay: () => void;
  onJumpToReviewCapture: (captureId: number) => void;
  onApplyTagFilter: (tag: string) => void;
  onNoteDraftChange: (nextValue: string) => void;
  onTagDraftChange: (nextValue: string) => void;
  onRedactCapture: () => void;
  onSaveTags: () => void;
  onSetCompareAnchor: () => void;
  onSaveNote: () => void;
  onSelectSearchResult: (result: RetrievalSearchResult) => void;
  onSearchQueryChange: (nextValue: string) => void;
  onTogglePause: () => void;
  onToggleBookmark: () => void;
  onToggleFavorite: () => void;
  reviewShortcuts: ReviewShortcutsPayload;
  searchInputRef: MutableRefObject<HTMLInputElement | null>;
  selectedCapture: CaptureRecord | null;
  selectedDaySummary: DaySummary;
  storageStats: StorageStatsPayload;
  tagDraft: string;
  todayCaptureCount: number;
};

type SettingsModalProps = {
  backupImportPath: string;
  backupPassphrase: string;
  backupStatus: string;
  backupStatusTone: "neutral" | "success" | "error";
  draftExcludedProcessesText: string;
  draftExcludedWindowKeywordsText: string;
  draftIntervalMinutes: number;
  draftPauseProcessesText: string;
  draftPauseWindowKeywordsText: string;
  draftThemeId: ThemeId;
  draftRetentionDays: number;
  draftSensitiveCaptureMode: SensitiveCaptureMode;
  draftSensitiveWindowKeywordsText: string;
  draftStorageCapGb: number;
  isBackupBusy: boolean;
  isReindexBusy: boolean;
  isCustomInterval: boolean;
  maintenanceStage: string;
  maintenanceProgress: number;
  ocrHealth: OcrHealthPayload;
  ocrReindexStatus: string;
  ocrReindexStatusTone: "neutral" | "success" | "error";
  onBackupImportPathChange: (nextValue: string) => void;
  onBackupPassphraseChange: (nextValue: string) => void;
  onDraftExcludedProcessesTextChange: (nextValue: string) => void;
  onDraftExcludedWindowKeywordsTextChange: (nextValue: string) => void;
  onEnableCustomInterval: () => void;
  onClose: () => void;
  onDraftPauseProcessesTextChange: (nextValue: string) => void;
  onDraftPauseWindowKeywordsTextChange: (nextValue: string) => void;
  onDraftSensitiveCaptureModeChange: (nextValue: SensitiveCaptureMode) => void;
  onDraftSensitiveWindowKeywordsTextChange: (nextValue: string) => void;
  onDraftThemeChange: (nextValue: ThemeId) => void;
  onDraftIntervalChange: (nextValue: number) => void;
  onSelectPresetInterval: (nextValue: number) => void;
  onDraftRetentionChange: (nextValue: number) => void;
  onDraftStorageCapChange: (nextValue: number) => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
  onReindexAllCaptures: () => void;
  onOpenCapturesFolder: () => void;
  onResetDraft: () => void;
  onSaveSettings: () => void;
  settingsDirty: boolean;
  themeId: ThemeId;
  themeOptions: ThemeOption[];
  storagePath: string;
  storageStats: StorageStatsPayload;
};

type ThemeOnboardingModalProps = {
  isSaving: boolean;
  selectedThemeId: ThemeId;
  themeOptions: ThemeOption[];
  onConfirm: () => void;
  onSelectTheme: (themeId: ThemeId) => void;
};

type TimelineStripProps = {
  captures: CaptureRecord[];
  hasNewerPages: boolean;
  hasOlderPages: boolean;
  hourMarkers: string[];
  isPageLoading: boolean;
  loadedEndOffset: number;
  loadedStartOffset: number;
  onLoadNewer: () => void;
  onLoadOlder: () => void;
  onSelectCapture: (captureId: number) => void;
  onSelectCaptureAtIndex: (index: number) => void;
  searchQuery: string;
  selectedCaptureId: number | null;
  selectedCaptureIndex: number;
  selectedDayCaptureCount: number;
  thumbRefs: MutableRefObject<Record<number, HTMLButtonElement | null>>;
  trailingSpacerWidth: number;
  leadingSpacerWidth: number;
  virtualCaptures: CaptureRecord[];
};

const EMPTY_DENSITY = [0.08, 0.12, 0.18, 0.26, 0.22, 0.16, 0.12, 0.08];
const INTERVAL_MIN_MINUTES = 1;
const INTERVAL_MAX_MINUTES = 240;
const INTERVAL_OPTIONS = [1, 2, 5, 10, 15, 30, 60, 120];
const TIMELINE_PAGE_LIMIT = 240;
const TIMELINE_VIRTUAL_WINDOW = 72;
const TIMELINE_THUMB_WIDTH_PX = 96;
const LEGACY_THEME_ID: ThemeId = "amber-noir";
const ONBOARDING_THEME_ID: ThemeId = "obsidian-jade";
const SEARCH_SUGGESTIONS = [
  "around 3 PM yesterday",
  "release notes",
  "app:figma",
  "tag:roadmap",
  "bookmarked favorite",
];

const MATCH_SOURCE_LABELS: Record<string, string> = {
  note: "note",
  ocr: "ocr",
  window: "window",
  app: "app",
  tag: "tag",
  bookmark: "bookmark",
  favorite: "favorite",
  time: "time",
  day: "day",
  metadata: "metadata",
  "exact phrase": "exact phrase",
  "all terms": "all terms",
};

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: "amber-noir",
    name: "Amber Noir",
    mood: "warm, editorial, grounded",
    swatches: ["#0f0d0b", "#251f1b", "#d58a33", "#2f5d8a"],
  },
  {
    id: "obsidian-jade",
    name: "Obsidian Jade",
    mood: "cool, focused, terminal-adjacent",
    swatches: ["#0b0f0e", "#0e1411", "#3ecf8e", "#1e5f8a"],
  },
  {
    id: "arctic-slate",
    name: "Arctic Slate",
    mood: "clean, minimal, professional",
    swatches: ["#f0f2f5", "#ffffff", "#3a6fd8", "#7c5cbf"],
  },
  {
    id: "deep-plum",
    name: "Deep Plum",
    mood: "dramatic, editorial, premium dark",
    swatches: ["#0d0b12", "#18151f", "#9b6dff", "#d4547a"],
  },
  {
    id: "midnight-blue",
    name: "Midnight Blue",
    mood: "sleek, modern, lightly corporate",
    swatches: ["#090c12", "#101521", "#4d8ef0", "#2a7a8a"],
  },
];

function isThemeId(value: string): value is ThemeId {
  return THEME_OPTIONS.some((option) => option.id === value);
}

function resolveThemeId(value: string | null | undefined): ThemeId {
  const normalized = (value ?? "").trim().toLowerCase();
  if (isThemeId(normalized)) {
    return normalized;
  }

  return LEGACY_THEME_ID;
}

function resolveSensitiveCaptureMode(value: string | null | undefined): SensitiveCaptureMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "redact" || normalized === "pause") {
    return normalized;
  }

  return "skip";
}

function parseListEditorText(value: string, maxItems = 24): string[] {
  const entries = value
    .split(/[\n,;]/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const normalized = entry.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(entry.slice(0, 80));

    if (deduped.length >= maxItems) {
      break;
    }
  }

  return deduped;
}

function listToEditorText(values: string[]): string {
  return values.join(", ");
}

function haveSameListValues(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const leftNormalized = [...left].map((value) => value.toLowerCase()).sort();
  const rightNormalized = [...right].map((value) => value.toLowerCase()).sort();

  for (let index = 0; index < leftNormalized.length; index += 1) {
    if (leftNormalized[index] !== rightNormalized[index]) {
      return false;
    }
  }

  return true;
}

function parseTagDraftInput(value: string): string[] {
  return parseListEditorText(value, 16).map((entry) => entry.slice(0, 32));
}

function themeName(themeId: ThemeId): string {
  return THEME_OPTIONS.find((option) => option.id === themeId)?.name ?? "Theme";
}

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

function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatRangeLabel(captures: CaptureRecord[]): string {
  if (captures.length === 0) {
    return "Waiting for first capture";
  }

  return `${captures[0].timestampLabel} to ${captures[captures.length - 1].timestampLabel}`;
}

function formatCaptureTimestamp(capturedAt: string): string {
  const parsed = new Date(capturedAt);
  if (Number.isNaN(parsed.getTime())) {
    return capturedAt;
  }

  return parsed.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function clampIntervalMinutes(value: number): number {
  return Math.max(INTERVAL_MIN_MINUTES, Math.min(INTERVAL_MAX_MINUTES, value));
}

function formatStorageValue(usedGb: number): string {
  if (usedGb >= 10) {
    return `${usedGb.toFixed(1)} GB`;
  }

  return `${usedGb.toFixed(2)} GB`;
}

function formatMatchSourceLabel(source: string): string {
  const normalized = source.trim().toLowerCase();
  return MATCH_SOURCE_LABELS[normalized] ?? normalized;
}

function fallbackDays(): DaySummary[] {
  const days: DaySummary[] = [];

  for (let index = 0; index < 14; index += 1) {
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

function mergeCaptures(existing: CaptureRecord[], incoming: CaptureRecord[]): CaptureRecord[] {
  const merged = new Map<number, CaptureRecord>();

  for (const capture of existing) {
    merged.set(capture.id, capture);
  }

  for (const capture of incoming) {
    merged.set(capture.id, capture);
  }

  return Array.from(merged.values()).sort(
    (left, right) => new Date(left.capturedAt).getTime() - new Date(right.capturedAt).getTime(),
  );
}

function buildHourMarkers(captures: CaptureRecord[]): string[] {
  if (captures.length === 0) {
    return [];
  }

  const start = new Date(captures[0].capturedAt);
  const end = new Date(captures[captures.length - 1].capturedAt);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return ["9 AM", "12 PM", "3 PM", "6 PM"];
  }

  const startHour = start.getHours();
  const endHour = Math.max(startHour, end.getHours());
  const spanHours = Math.max(1, endHour - startHour + 1);
  const step = Math.max(1, Math.ceil(spanHours / 6));
  const markers: string[] = [];

  for (let hour = startHour; hour <= endHour; hour += step) {
    const marker = new Date(start);
    marker.setHours(hour, 0, 0, 0);
    markers.push(marker.toLocaleTimeString("en-US", { hour: "numeric" }));
  }

  const lastMarker = end.toLocaleTimeString("en-US", { hour: "numeric" });
  if (markers[markers.length - 1] !== lastMarker) {
    markers.push(lastMarker);
  }

  return markers;
}

function deriveContextBadge(capture: CaptureRecord | null): string {
  if (!capture) {
    return "No capture selected";
  }

  const title = capture.windowTitle.trim();
  const processName = capture.processName.trim();

  if (title && processName) {
    return `${processName} · ${title}`;
  }

  if (title) {
    return title;
  }

  if (processName) {
    return `App: ${processName}`;
  }

  return "Window metadata unavailable for this capture";
}

function densityMiniBars(density: number[]): number[] {
  const values = density.length > 0 ? density : EMPTY_DENSITY;
  return [values[0] ?? 0.1, values[3] ?? 0.2, values[7] ?? 0.1];
}

function renderHighlightedSnippet(snippet: string, highlightTerms: string[]): ReactNode {
  if (!snippet || highlightTerms.length === 0) {
    return snippet;
  }

  const normalized = snippet.toLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];

  for (const term of highlightTerms) {
    const needle = term.trim().toLowerCase();
    if (!needle) {
      continue;
    }

    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(needle, offset);
      if (index < 0) {
        break;
      }

      ranges.push({ start: index, end: index + needle.length });
      offset = index + needle.length;
    }
  }

  if (ranges.length === 0) {
    return snippet;
  }

  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];

  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (!previous || range.start > previous.end) {
      merged.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }

  const segments: ReactNode[] = [];
  let cursor = 0;

  merged.forEach((range, index) => {
    if (range.start > cursor) {
      segments.push(<span key={`plain-${cursor}-${index}`}>{snippet.slice(cursor, range.start)}</span>);
    }

    segments.push(<mark key={`highlight-${range.start}-${range.end}`}>{snippet.slice(range.start, range.end)}</mark>);
    cursor = range.end;
  });

  if (cursor < snippet.length) {
    segments.push(<span key={`plain-tail-${cursor}`}>{snippet.slice(cursor)}</span>);
  }

  return <>{segments}</>;
}

function TopBar({
  hasNextDay,
  hasPreviousDay,
  isWindowMaximized,
  isJumpToNowDisabled,
  isRecording,
  selectedDayCaptureCount,
  selectedDayKey,
  selectedDayLabel,
  todayKey,
  onJumpToNow,
  onOpenSettings,
  onSelectDay,
  onSelectNextDay,
  onSelectPreviousDay,
  onToggleWindowMaximize,
}: TopBarProps) {
  return (
    <header className={isWindowMaximized ? "panel topbar is-maximized" : "panel topbar"}>
      <div className="topbar-brand" data-tauri-drag-region onDoubleClick={onToggleWindowMaximize}>
        <img src="/memorylane_logo.jpg" alt="" aria-hidden="true" />
        <strong>MemoryLane</strong>
        <span className={isRecording ? "status-pill recording" : "status-pill paused"}>
          {isRecording ? "recording" : "paused"}
        </span>
      </div>

      <div className="topbar-focus">
        <p className="topbar-focus-label" data-tauri-drag-region>
          Selected day
        </p>
        <div className="topbar-day-row">
          <button
            className="secondary compact topbar-nav"
            type="button"
            onClick={onSelectPreviousDay}
            disabled={!hasPreviousDay}
            aria-label="Previous day"
          >
            ←
          </button>

          <div className="topbar-day-summary-hitbox" data-tauri-drag-region onDoubleClick={onToggleWindowMaximize}>
            <div className="topbar-day-summary">
              <h1>{selectedDayLabel}</h1>
              <p>{selectedDayCaptureCount} captures</p>
            </div>
          </div>

          <button
            className="secondary compact topbar-nav"
            type="button"
            onClick={onSelectNextDay}
            disabled={!hasNextDay}
            aria-label="Next day"
          >
            →
          </button>
        </div>
      </div>

      <div className="topbar-actions">
        <label className="topbar-date-input" htmlFor="topbar-date-input">
          <span className="visually-hidden">Jump to date</span>
          <input
            id="topbar-date-input"
            type="date"
            value={selectedDayKey}
            max={todayKey}
            onChange={(event) => {
              const nextDayKey = event.currentTarget.value;
              if (isDayKey(nextDayKey)) {
                onSelectDay(nextDayKey);
              }
            }}
          />
        </label>

        <button className="secondary compact topbar-now" type="button" onClick={onJumpToNow} disabled={isJumpToNowDisabled}>
          now
        </button>

        <button className="secondary icon-button" type="button" title="Settings" aria-label="Open settings" onClick={onOpenSettings}>
          <svg className="settings-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.05A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.05A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.05A1.7 1.7 0 0 0 19.4 15Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function WindowControls({
  isWindowMaximized,
  onCloseWindow,
  onMinimizeWindow,
  onToggleWindowMaximize,
}: WindowControlsProps) {
  return (
    <div
      className={isWindowMaximized ? "window-controls-rail is-maximized" : "window-controls-rail"}
      role="toolbar"
      aria-label="Window controls"
    >
      <button
        className="secondary topbar-window-btn"
        type="button"
        title="Minimize"
        aria-label="Minimize window"
        onClick={onMinimizeWindow}
      >
        <span aria-hidden="true">_</span>
      </button>
      <button
        className="secondary topbar-window-btn"
        type="button"
        title={isWindowMaximized ? "Restore" : "Maximize"}
        aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
        onClick={onToggleWindowMaximize}
      >
        <span aria-hidden="true">{isWindowMaximized ? "❐" : "□"}</span>
      </button>
      <button
        className="secondary topbar-window-btn topbar-window-close"
        type="button"
        title="Close"
        aria-label="Close window"
        onClick={onCloseWindow}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

function DayRail({ recentDays, selectedDayKey, todayKey, onJumpToToday, onSelectDay }: DayRailProps) {
  const todayDate = dayDateFromKey(todayKey);

  return (
    <aside className="panel day-rail">
      <button className="day-rail-entry today" type="button" onClick={onJumpToToday} title={`Jump to ${formatViewerDate(todayKey)}`}>
        <span className="day-rail-number">{todayDate.getDate()}</span>
        <span className="day-rail-label">Today</span>
        <span className="day-rail-meta">Now</span>
      </button>

      <div className="day-rail-list">
        {recentDays.map((day) => {
          const isSelected = day.dayKey === selectedDayKey;
          const bars = densityMiniBars(day.density);
          const dayDate = dayDateFromKey(day.dayKey);
          const primaryLabel = formatDayLabel(day.dayKey);
          const secondaryLabel = formatDaySecondary(day.dayKey);

          return (
            <button
              key={day.dayKey}
              className={isSelected ? "day-rail-entry selected" : "day-rail-entry"}
              type="button"
              title={`${formatViewerDate(day.dayKey)} · ${day.captureCount} captures`}
              onClick={() => onSelectDay(day.dayKey)}
            >
              <span className="day-rail-number">{dayDate.getDate()}</span>
              <span className="day-rail-label">{primaryLabel}</span>
              <span className="day-rail-meta">{secondaryLabel}</span>
              <span className="day-rail-dots" aria-hidden="true">
                {bars.map((value, index) => (
                  <span key={`${day.dayKey}-${index}`} style={{ opacity: 0.3 + value * 0.7 }} />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function ViewerPane({
  actionMessage,
  captureHealth,
  captures,
  compareCaptureLabel,
  compareImageDataUrl,
  contextBadge,
  isFilterActive,
  onCopyPath,
  onClearCompareAnchor,
  onDeleteCapture,
  onOpenCapturesFolder,
  onRedactCapture,
  onSetCompareAnchor,
  onSelectNext,
  onSelectPrevious,
  onToggleBookmark,
  onToggleFavorite,
  selectedCapture,
  selectedCaptureIndex,
  selectedDayLabel,
  selectedDaySummary,
  selectedImageDataUrl,
}: ViewerPaneProps) {
  const hasCaptures = Boolean(selectedCapture && captures.length > 0);
  const hasCompareAnchor = Boolean(compareCaptureLabel);

  return (
    <main className="panel viewer-pane">
      <div className="viewer-head">
        <p className="section-title">Selected day</p>
        <h2>{selectedDayLabel}</h2>
        <p>
          {isFilterActive
            ? `Showing ${captures.length} of ${selectedDaySummary.captureCount} captures`
            : `${selectedDaySummary.captureCount} captures`}
        </p>
      </div>

      {hasCaptures ? (
        <section className="viewer-stage">
          <div className="capture-frame">
            <button
              className="viewer-step viewer-step-left"
              type="button"
              onClick={onSelectPrevious}
              disabled={selectedCaptureIndex <= 0}
              aria-label="Previous capture"
            >
              &lt;
            </button>

            {hasCompareAnchor ? (
              <div className="capture-compare-grid">
                <div className="capture-compare-panel">
                  <p className="overlay-label">Compare anchor</p>
                  <h4>{compareCaptureLabel}</h4>
                  {compareImageDataUrl ? (
                    <img className="capture-image" src={compareImageDataUrl} alt="Compare anchor screenshot" />
                  ) : (
                    <div className="capture-loading">
                      <p>Loading compare capture...</p>
                    </div>
                  )}
                </div>

                <div className="capture-compare-panel">
                  <p className="overlay-label">Selected capture</p>
                  <h4>{selectedCapture?.timestampLabel ?? "Selected"}</h4>
                  {selectedImageDataUrl ? (
                    <img
                      className="capture-image"
                      src={selectedImageDataUrl}
                      alt={`Screenshot captured at ${selectedCapture?.timestampLabel ?? "selected time"}`}
                    />
                  ) : (
                    <div className="capture-loading">
                      <p>Loading capture preview...</p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <>
                {selectedImageDataUrl ? (
                  <img
                    className="capture-image"
                    src={selectedImageDataUrl}
                    alt={`Screenshot captured at ${selectedCapture?.timestampLabel ?? "selected time"}`}
                  />
                ) : (
                  <div className="capture-loading">
                    <p>Loading capture preview...</p>
                  </div>
                )}
              </>
            )}

            <button
              className="viewer-step viewer-step-right"
              type="button"
              onClick={onSelectNext}
              disabled={selectedCaptureIndex >= captures.length - 1}
              aria-label="Next capture"
            >
              &gt;
            </button>

            <div className="capture-overlay">
              <div className="capture-meta">
                <p className="overlay-label">{selectedCapture?.timestampLabel ?? "Selected capture"}</p>
                <h3>{selectedCapture ? formatCaptureTimestamp(selectedCapture.capturedAt) : "Capture unavailable"}</h3>
                <p className="context-badge">{contextBadge}</p>
                {selectedCapture ? (
                  <div className="retrieval-result-badges capture-review-badges">
                    {selectedCapture.isBookmarked ? <span className="source-pill">bookmarked</span> : null}
                    {selectedCapture.isFavorite ? <span className="source-pill">favorite</span> : null}
                    {selectedCapture.tags.slice(0, 3).map((tag) => (
                      <span key={`${selectedCapture.id}-tag-${tag}`} className="source-pill">
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="overlay-actions">
                <button className="secondary compact" type="button" onClick={onToggleBookmark}>
                  {selectedCapture?.isBookmarked ? "remove bookmark" : "bookmark"}
                </button>
                <button className="secondary compact" type="button" onClick={onToggleFavorite}>
                  {selectedCapture?.isFavorite ? "remove favorite" : "favorite"}
                </button>
                {hasCompareAnchor ? (
                  <button className="secondary compact" type="button" onClick={onClearCompareAnchor}>
                    clear compare
                  </button>
                ) : (
                  <button className="secondary compact" type="button" onClick={onSetCompareAnchor}>
                    set compare
                  </button>
                )}
                <button className="secondary compact" type="button" onClick={onOpenCapturesFolder}>
                  open folder
                </button>
                <button className="secondary compact" type="button" onClick={onCopyPath}>
                  copy path
                </button>
                <button className="secondary compact" type="button" onClick={onRedactCapture}>
                  redact
                </button>
                <button className="danger compact" type="button" onClick={onDeleteCapture}>
                  delete
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="empty-state">
          <p className="section-title">No captures in view</p>
          <h3>{isFilterActive ? "No match for this search" : "Your visual timeline starts in the tray"}</h3>
          <p>
            {isFilterActive
              ? "Try a different time or note keyword to see captures again."
              : "MemoryLane runs locally in the background and fills this viewer as screenshots arrive."}
          </p>
          <div className="empty-actions">
            <button className="secondary" type="button" onClick={onOpenCapturesFolder}>
              open captures folder
            </button>
          </div>
        </section>
      )}

      <p className={captureHealth.consecutiveFailures > 0 ? "viewer-message warning" : "viewer-message"}>
        {captureHealth.consecutiveFailures > 0 && captureHealth.lastError
          ? `Capture issues: ${captureHealth.consecutiveFailures} failure(s). Last: ${captureHealth.lastError}`
          : actionMessage}
      </p>
    </main>
  );
}

function UtilityRail({
  activeRetrievalResultIndex,
  captureSearchQuery,
  compareCaptureLabel,
  dayIntelligence,
  dayIntelligenceError,
  dayIntelligenceLoading,
  intervalMinutes,
  isReviewBusy,
  isRetrievalLoading,
  isRecording,
  nextCaptureLabel,
  noteDirty,
  noteDraft,
  noteSaveState,
  ocrHealth,
  performanceSnapshot,
  retrievalError,
  retrievalResults,
  onCaptureNow,
  onClearCompareAnchor,
  onDeleteDay,
  onJumpToReviewCapture,
  onApplyTagFilter,
  onNoteDraftChange,
  onTagDraftChange,
  onRedactCapture,
  onSaveTags,
  onSetCompareAnchor,
  onSaveNote,
  onSelectSearchResult,
  onSearchQueryChange,
  onTogglePause,
  onToggleBookmark,
  onToggleFavorite,
  reviewShortcuts,
  searchInputRef,
  selectedCapture,
  selectedDaySummary,
  storageStats,
  tagDraft,
  todayCaptureCount,
}: UtilityRailProps) {
  const noteStatusLabel =
    noteSaveState === "saving"
      ? "Saving..."
      : noteSaveState === "saved"
        ? "Saved"
        : noteSaveState === "error"
          ? "Save failed"
          : noteDirty
            ? "Unsaved"
            : "";
  const focusPreview = dayIntelligence?.focusBlocks.slice(0, 3) ?? [];
  const focusOverflow = dayIntelligence?.focusBlocks.slice(3) ?? [];
  const highlightsPreview = dayIntelligence?.changeHighlights.slice(0, 3) ?? [];
  const highlightsOverflow = dayIntelligence?.changeHighlights.slice(3) ?? [];
  const topThemePreview = dayIntelligence?.topTerms.slice(0, 4) ?? [];

  return (
    <aside className="panel utility-rail">
      <section className="utility-section">
        <h3>Today</h3>
        <div className="today-stat-grid">
          <div>
            <strong>{todayCaptureCount}</strong>
            <span>captures</span>
          </div>
          <div>
            <strong>{intervalMinutes}m</strong>
            <span>cadence</span>
          </div>
        </div>
      </section>

      <section className="utility-section">
        <h3>Search Captures</h3>
        <div className="search-command">
          <span className="search-command-key">/</span>
          <input
            ref={searchInputRef}
            type="text"
            value={captureSearchQuery}
            placeholder="Search notes, OCR, apps, or around 3 PM..."
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
          />
        </div>
        {!ocrHealth.engineAvailable ? <p className="storage-meta warning">{ocrHealth.statusMessage}</p> : null}
        {captureSearchQuery.trim().length === 0 ? (
          <>
            <p className="storage-meta">Press `/` to search. Use `n` / `Shift+n` to move through matches.</p>
            <div className="search-suggestion-row">
              {SEARCH_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  className="secondary compact search-suggestion"
                  type="button"
                  onClick={() => onSearchQueryChange(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </>
        ) : null}
        {captureSearchQuery.trim().length > 0 ? (
          <>
            <p className="storage-meta">Local search across notes, OCR text, app metadata, time hints, and filters like app:, window:, tag:, bookmarked, favorite.</p>
            {isRetrievalLoading ? <p className="storage-meta">Searching archive...</p> : null}
            {retrievalError ? <p className="storage-meta">{retrievalError}</p> : null}
            {!isRetrievalLoading && !retrievalError ? (
              retrievalResults.length > 0 ? (
                <div className="retrieval-results" role="list" aria-label="Archive search results">
                  {retrievalResults.map((result, index) => (
                    <button
                      key={result.captureId}
                      className={index === activeRetrievalResultIndex ? "retrieval-result active" : "retrieval-result"}
                      type="button"
                      onClick={() => onSelectSearchResult(result)}
                    >
                      <div className="retrieval-result-header">
                        <strong>
                          {formatViewerDate(result.dayKey)} · {result.timestampLabel}
                        </strong>
                        <div className="retrieval-result-badges">
                          {result.matchSources.length > 0
                            ? result.matchSources.slice(0, 4).map((source) => (
                                <span key={`${result.captureId}-${source}`} className="source-pill">
                                  {formatMatchSourceLabel(source)}
                                </span>
                              ))
                            : [<span key={`${result.captureId}-match`} className="source-pill">match</span>]}
                          {result.isBookmarked ? <span className="source-pill">bookmarked</span> : null}
                          {result.isFavorite ? <span className="source-pill">favorite</span> : null}
                          {result.tags.slice(0, 2).map((tag) => (
                            <span key={`${result.captureId}-tag-${tag}`} className="source-pill">
                              #{tag}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span>{result.matchReason}</span>
                      <small>{renderHighlightedSnippet(result.snippet, result.highlightTerms)}</small>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="storage-meta">No matches yet. Try broader terms or a time hint like "around 2 PM".</p>
              )
            ) : null}
          </>
        ) : null}
      </section>

      <section className="utility-section intelligence-section">
        <div className="section-row intelligence-head">
          <h3>Day Intelligence</h3>
          {dayIntelligence ? (
            <span className="source-pill intelligence-session-pill">{dayIntelligence.focusBlocks.length} sessions</span>
          ) : null}
        </div>
        {dayIntelligenceLoading ? <p className="storage-meta">Summarizing this day...</p> : null}
        {dayIntelligenceError ? <p className="storage-meta">{dayIntelligenceError}</p> : null}
        {!dayIntelligenceLoading && !dayIntelligenceError && dayIntelligence ? (
          <>
            <p className="storage-meta intelligence-summary">{dayIntelligence.summary}</p>

            {topThemePreview.length > 0 ? (
              <div className="retrieval-result-badges intelligence-themes" aria-label="Top themes">
                {topThemePreview.map((term, index) => (
                  <span key={`term-${index}-${term}`} className="source-pill">
                    {term}
                  </span>
                ))}
              </div>
            ) : null}

            {focusPreview.length > 0 ? (
              <div className="intelligence-blocks">
                {focusPreview.map((block) => (
                  <article key={`${block.startTimestampLabel}-${block.endTimestampLabel}`} className="intelligence-block">
                    <strong>
                      {block.startTimestampLabel} - {block.endTimestampLabel}
                    </strong>
                    <span>{block.captureCount} captures</span>
                    <p>{block.dominantContext}</p>
                  </article>
                ))}
              </div>
            ) : null}

            {focusOverflow.length > 0 ? (
              <details className="intelligence-fold">
                <summary>Show {focusOverflow.length} more session{focusOverflow.length === 1 ? "" : "s"}</summary>
                <div className="intelligence-blocks intelligence-blocks-overflow">
                  {focusOverflow.map((block) => (
                    <article key={`${block.startTimestampLabel}-${block.endTimestampLabel}`} className="intelligence-block">
                      <strong>
                        {block.startTimestampLabel} - {block.endTimestampLabel}
                      </strong>
                      <span>{block.captureCount} captures</span>
                      <p>{block.dominantContext}</p>
                    </article>
                  ))}
                </div>
              </details>
            ) : null}

            {highlightsPreview.length > 0 ? (
              <>
                <p className="intelligence-subtitle">What changed today</p>
                <ul className="intelligence-highlights">
                  {highlightsPreview.map((highlight, index) => (
                    <li key={`highlight-preview-${index}-${highlight}`}>{highlight}</li>
                  ))}
                </ul>
              </>
            ) : null}

            {highlightsOverflow.length > 0 ? (
              <details className="intelligence-fold">
                <summary>Show {highlightsOverflow.length} more change note{highlightsOverflow.length === 1 ? "" : "s"}</summary>
                <ul className="intelligence-highlights intelligence-highlights-overflow">
                  {highlightsOverflow.map((highlight, index) => (
                    <li key={`highlight-overflow-${index}-${highlight}`}>{highlight}</li>
                  ))}
                </ul>
              </details>
            ) : null}

            {highlightsPreview.length === 0 && highlightsOverflow.length === 0 ? (
              <p className="storage-meta">No major context shifts detected for this day.</p>
            ) : null}

            {dayIntelligence.focusBlocks.length === 0 ? (
              <p className="storage-meta">No sessions yet. Captures will appear here as your day fills in.</p>
            ) : null}
          </>
        ) : null}
      </section>

      <section className="utility-section">
        <div className="section-row">
          <h3>Note This Capture</h3>
          <span className="note-status">{noteStatusLabel}</span>
        </div>
        <textarea
          value={noteDraft}
          placeholder={selectedCapture ? "Add a note to this capture..." : "Select a capture to write a note..."}
          disabled={!selectedCapture}
          onChange={(event) => onNoteDraftChange(event.currentTarget.value)}
          onBlur={() => {
            if (noteDirty) {
              onSaveNote();
            }
          }}
        />
        <button className="secondary compact" type="button" onClick={onSaveNote} disabled={!selectedCapture || !noteDirty}>
          save note
        </button>
      </section>

      <section className="utility-section">
        <h3>Review Tools</h3>
        {compareCaptureLabel ? <p className="storage-meta">Compare anchor: {compareCaptureLabel}</p> : null}
        <div className="review-actions-grid">
          <button className="secondary compact" type="button" onClick={onToggleBookmark} disabled={!selectedCapture || isReviewBusy}>
            {selectedCapture?.isBookmarked ? "unbookmark" : "bookmark"}
          </button>
          <button className="secondary compact" type="button" onClick={onToggleFavorite} disabled={!selectedCapture || isReviewBusy}>
            {selectedCapture?.isFavorite ? "unfavorite" : "favorite"}
          </button>
          {compareCaptureLabel ? (
            <button className="secondary compact" type="button" onClick={onClearCompareAnchor} disabled={isReviewBusy}>
              clear compare
            </button>
          ) : (
            <button className="secondary compact" type="button" onClick={onSetCompareAnchor} disabled={!selectedCapture || isReviewBusy}>
              set compare
            </button>
          )}
          <button className="secondary compact" type="button" onClick={onRedactCapture} disabled={!selectedCapture || isReviewBusy}>
            redact capture
          </button>
        </div>

        <label className="field-block" htmlFor="capture-tags-input">
          <span>Tags (comma separated)</span>
          <input
            id="capture-tags-input"
            type="text"
            value={tagDraft}
            placeholder="roadmap, launch, meeting"
            disabled={!selectedCapture}
            onChange={(event) => onTagDraftChange(event.currentTarget.value)}
          />
        </label>
        <button className="secondary compact" type="button" onClick={onSaveTags} disabled={!selectedCapture || isReviewBusy}>
          save tags
        </button>

        {selectedCapture?.tags.length ? (
          <div className="retrieval-result-badges">
            {selectedCapture.tags.map((tag) => (
              <button
                key={`${selectedCapture.id}-selected-tag-${tag}`}
                className="source-pill source-pill-button"
                type="button"
                onClick={() => onApplyTagFilter(tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        ) : null}

        <div className="review-shortcuts-grid">
          <p className="storage-meta">Bookmarks</p>
          {reviewShortcuts.bookmarks.length === 0 ? (
            <p className="storage-meta">No bookmarks yet.</p>
          ) : (
            reviewShortcuts.bookmarks.slice(0, 4).map((shortcut) => (
              <button
                key={`bookmark-${shortcut.captureId}`}
                className="secondary compact review-jump"
                type="button"
                onClick={() => onJumpToReviewCapture(shortcut.captureId)}
              >
                {formatViewerDate(shortcut.dayKey)} · {shortcut.timestampLabel}
              </button>
            ))
          )}
        </div>

        <div className="review-shortcuts-grid">
          <p className="storage-meta">Favorites</p>
          {reviewShortcuts.favorites.length === 0 ? (
            <p className="storage-meta">No favorites yet.</p>
          ) : (
            reviewShortcuts.favorites.slice(0, 4).map((shortcut) => (
              <button
                key={`favorite-${shortcut.captureId}`}
                className="secondary compact review-jump"
                type="button"
                onClick={() => onJumpToReviewCapture(shortcut.captureId)}
              >
                {formatViewerDate(shortcut.dayKey)} · {shortcut.timestampLabel}
              </button>
            ))
          )}
        </div>

        {reviewShortcuts.tags.length > 0 ? (
          <div className="review-shortcuts-grid">
            <p className="storage-meta">Top tags</p>
            <div className="retrieval-result-badges">
              {reviewShortcuts.tags.slice(0, 8).map((tag) => (
                <button
                  key={`tag-shortcut-${tag.tag}`}
                  className="source-pill source-pill-button"
                  type="button"
                  onClick={() => onApplyTagFilter(tag.tag)}
                >
                  #{tag.tag} ({tag.captureCount})
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      <section className="utility-section">
        <h3>Recording</h3>
        <div className="recording-row">
          <span>{isRecording ? "active" : "paused"} · {intervalMinutes} min cadence</span>
          <button className="secondary compact" type="button" onClick={onTogglePause}>
            {isRecording ? "pause" : "resume"}
          </button>
        </div>
        <p className="storage-meta">{isRecording ? nextCaptureLabel : "Capture paused"}</p>
        <button className="secondary compact" type="button" onClick={onCaptureNow}>
          capture now
        </button>
      </section>

      <section className="utility-section">
        <h3>Storage</h3>
        <div className="usage-track" role="presentation">
          <span style={{ width: `${storageStats.usagePercent}%` }} />
        </div>
        <p className="storage-meta">
          {formatStorageValue(storageStats.usedGb)} used · {storageStats.storageCapGb.toFixed(1)} GB cap
        </p>
        <p className="storage-meta">
          search {performanceSnapshot.lastSearchMs}ms · intelligence {performanceSnapshot.lastIntelligenceMs}ms
        </p>
        <p className="storage-meta">
          cache hits {performanceSnapshot.searchCacheHits}/{performanceSnapshot.intelligenceCacheHits}
        </p>
      </section>

      <section className="utility-section">
        <h3>Day Actions</h3>
        <p className="storage-meta">
          {formatViewerDate(selectedDaySummary.dayKey)} · {selectedDaySummary.captureCount} captures
        </p>
        <button
          className="danger compact"
          type="button"
          onClick={onDeleteDay}
          disabled={selectedDaySummary.captureCount === 0}
        >
          delete selected day
        </button>
      </section>
    </aside>
  );
}

function SettingsModal({
  backupImportPath,
  backupPassphrase,
  backupStatus,
  backupStatusTone,
  draftExcludedProcessesText,
  draftExcludedWindowKeywordsText,
  draftIntervalMinutes,
  draftPauseProcessesText,
  draftPauseWindowKeywordsText,
  draftThemeId,
  draftRetentionDays,
  draftSensitiveCaptureMode,
  draftSensitiveWindowKeywordsText,
  draftStorageCapGb,
  isBackupBusy,
  isReindexBusy,
  isCustomInterval,
  maintenanceStage,
  maintenanceProgress,
  ocrHealth,
  ocrReindexStatus,
  ocrReindexStatusTone,
  onBackupImportPathChange,
  onBackupPassphraseChange,
  onDraftExcludedProcessesTextChange,
  onDraftExcludedWindowKeywordsTextChange,
  onEnableCustomInterval,
  onClose,
  onDraftPauseProcessesTextChange,
  onDraftPauseWindowKeywordsTextChange,
  onDraftSensitiveCaptureModeChange,
  onDraftSensitiveWindowKeywordsTextChange,
  onDraftThemeChange,
  onDraftIntervalChange,
  onSelectPresetInterval,
  onDraftRetentionChange,
  onDraftStorageCapChange,
  onExportBackup,
  onImportBackup,
  onReindexAllCaptures,
  onOpenCapturesFolder,
  onResetDraft,
  onSaveSettings,
  settingsDirty,
  themeId,
  themeOptions,
  storagePath,
  storageStats,
}: SettingsModalProps) {
  const activeThemeOption = themeOptions.find((themeOption) => themeOption.id === draftThemeId);
  const savedThemeOption = themeOptions.find((themeOption) => themeOption.id === themeId);

  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        className="panel settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-head">
          <div>
            <p className="section-title">Settings</p>
            <h3 id="settings-modal-title">Preferences</h3>
            <p className="section-meta">
              {storageStats.captureCount} total captures · Current theme {savedThemeOption?.name ?? "Theme"}
            </p>
          </div>
          <div className="settings-head-actions">
            <span className={settingsDirty ? "settings-state-pill dirty" : "settings-state-pill clean"}>
              {settingsDirty ? "Unsaved changes" : "All changes saved"}
            </span>
            <button className="secondary compact" type="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <section className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <svg className="settings-section-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M6.9 3.7c1.8-.7 4-.3 5.5 1.2 2.2 2.2 2.2 5.8 0 8a4.9 4.9 0 0 1-3.6 1.5H6.7a2.4 2.4 0 0 1-2.3-2.9l.3-1.2a2 2 0 0 0-.5-1.9l-.4-.4A2.5 2.5 0 0 1 6.9 3.7Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="9.6" cy="7.2" r="0.85" fill="currentColor" />
                <circle cx="11.9" cy="8.6" r="0.85" fill="currentColor" />
                <circle cx="8.1" cy="9.3" r="0.85" fill="currentColor" />
              </svg>
              Appearance
            </h4>
            <span className="theme-pill">{activeThemeOption?.name ?? "Theme"}</span>
          </div>
          <p className="field-help">Pick the visual style used across the dashboard surfaces and accents.</p>
          <div className="theme-grid" role="listbox" aria-label="Theme options">
            {themeOptions.map((themeOption) => (
              <button
                key={themeOption.id}
                className={themeOption.id === draftThemeId ? "theme-card active" : "theme-card"}
                type="button"
                role="option"
                aria-selected={themeOption.id === draftThemeId}
                onClick={() => onDraftThemeChange(themeOption.id)}
              >
                <span className="theme-card-head">
                  <strong>{themeOption.name}</strong>
                  <span>{themeOption.mood}</span>
                </span>
                <span className="theme-swatches" aria-hidden="true">
                  {themeOption.swatches.map((swatch) => (
                    <span key={`${themeOption.id}-${swatch}`} style={{ backgroundColor: swatch }} />
                  ))}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <svg className="settings-section-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M10 3.4 4.6 5.6v3.2c0 3.5 2.3 6.7 5.4 7.8 3.1-1.1 5.4-4.3 5.4-7.8V5.6L10 3.4Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="m7.7 9.7 1.7 1.7 2.9-2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Trust and privacy
            </h4>
          </div>
          <p className="field-help">
            MemoryLane is local-first. These rules decide what gets skipped, auto-paused, or redacted before it is shown in search.
          </p>

          <div className="field-grid field-grid-tight">
            <label className="field-block" htmlFor="excluded-processes-input">
              <span>Exclude apps</span>
              <textarea
                id="excluded-processes-input"
                value={draftExcludedProcessesText}
                placeholder="banking.exe, password-manager.exe"
                onChange={(event) => onDraftExcludedProcessesTextChange(event.currentTarget.value)}
              />
              <p className="field-help">Comma or newline separated process names.</p>
            </label>

            <label className="field-block" htmlFor="excluded-windows-input">
              <span>Exclude window keywords</span>
              <textarea
                id="excluded-windows-input"
                value={draftExcludedWindowKeywordsText}
                placeholder="Payroll, HR portal"
                onChange={(event) => onDraftExcludedWindowKeywordsTextChange(event.currentTarget.value)}
              />
              <p className="field-help">If a window title contains these words, capture is skipped.</p>
            </label>
          </div>

          <div className="field-grid field-grid-tight">
            <label className="field-block" htmlFor="pause-processes-input">
              <span>Auto-pause apps</span>
              <textarea
                id="pause-processes-input"
                value={draftPauseProcessesText}
                placeholder="teams.exe, zoom.exe"
                onChange={(event) => onDraftPauseProcessesTextChange(event.currentTarget.value)}
              />
              <p className="field-help">Matching process names automatically pause recording.</p>
            </label>

            <label className="field-block" htmlFor="pause-windows-input">
              <span>Auto-pause window keywords</span>
              <textarea
                id="pause-windows-input"
                value={draftPauseWindowKeywordsText}
                placeholder="Interview panel, Incognito"
                onChange={(event) => onDraftPauseWindowKeywordsTextChange(event.currentTarget.value)}
              />
              <p className="field-help">Use this when you need strict pause rules by context.</p>
            </label>
          </div>

          <div className="field-grid field-grid-tight">
            <label className="field-block" htmlFor="sensitive-keywords-input">
              <span>Sensitive keywords</span>
              <textarea
                id="sensitive-keywords-input"
                value={draftSensitiveWindowKeywordsText}
                placeholder="password, otp, bank"
                onChange={(event) => onDraftSensitiveWindowKeywordsTextChange(event.currentTarget.value)}
              />
              <p className="field-help">If matched, use the selected mode below.</p>
            </label>

            <label className="field-block" htmlFor="sensitive-mode-select">
              <span>Sensitive mode</span>
              <select
                id="sensitive-mode-select"
                value={draftSensitiveCaptureMode}
                onChange={(event) => onDraftSensitiveCaptureModeChange(resolveSensitiveCaptureMode(event.currentTarget.value))}
              >
                <option value="skip">Skip capture</option>
                <option value="redact">Capture with redaction</option>
                <option value="pause">Auto-pause capture</option>
              </select>
              <p className="field-help">Choose between suppressing the capture, redacting image/metadata, or pausing recording.</p>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <svg className="settings-section-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <circle cx="10" cy="10" r="6.2" stroke="currentColor" strokeWidth="1.4" />
                <path d="M10 6.6v3.8l2.7 1.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Capture cadence
            </h4>
            <span className="section-meta">{draftIntervalMinutes} min</span>
          </div>
          <label className="field-block" htmlFor="interval-minutes">
            <p className="field-help">
              Presets are quick picks. Choose Custom to set any interval between {INTERVAL_MIN_MINUTES} and {INTERVAL_MAX_MINUTES}.
            </p>
            <div className="interval-grid">
              {INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={option === draftIntervalMinutes && !isCustomInterval ? "interval-btn active" : "interval-btn"}
                  type="button"
                  onClick={() => onSelectPresetInterval(option)}
                >
                  {option} min
                </button>
              ))}
              <button
                className={isCustomInterval ? "interval-btn active" : "interval-btn"}
                type="button"
                onClick={onEnableCustomInterval}
              >
                Custom
              </button>
            </div>
            {isCustomInterval ? (
              <>
                <span className="field-subtitle">Custom minutes</span>
                <input
                  id="interval-minutes"
                  type="number"
                  min={INTERVAL_MIN_MINUTES}
                  max={INTERVAL_MAX_MINUTES}
                  step={1}
                  value={draftIntervalMinutes}
                  aria-describedby="interval-minutes-help"
                  onChange={(event) =>
                    onDraftIntervalChange(
                      clampIntervalMinutes(Math.round(Number(event.currentTarget.value) || INTERVAL_MIN_MINUTES)),
                    )
                  }
                />
                <p className="field-help" id="interval-minutes-help">
                  Example: 10 means one screenshot every 10 minutes.
                </p>
              </>
            ) : (
              <p className="field-help" id="interval-minutes-help">
                Custom input stays hidden until you choose Custom.
              </p>
            )}
          </label>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <svg className="settings-section-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <ellipse cx="10" cy="5.3" rx="5.4" ry="2.3" stroke="currentColor" strokeWidth="1.4" />
                <path d="M4.6 5.3v7.1c0 1.3 2.4 2.3 5.4 2.3s5.4-1 5.4-2.3V5.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15.4 8.9c0 1.3-2.4 2.3-5.4 2.3s-5.4-1-5.4-2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Storage policy
            </h4>
          </div>
          <div className="field-grid field-grid-tight">
            <label className="field-block" htmlFor="retention-days">
              <span>Retention days</span>
              <input
                id="retention-days"
                type="number"
                min={1}
                max={365}
                value={draftRetentionDays}
                onChange={(event) => onDraftRetentionChange(Math.max(1, Number(event.currentTarget.value) || 1))}
              />
              <p className="field-help">Oldest day folders are removed after this many days.</p>
            </label>

            <label className="field-block" htmlFor="storage-cap-gb">
              <span>Storage cap (GB)</span>
              <input
                id="storage-cap-gb"
                type="number"
                min={0.5}
                max={100}
                step={0.5}
                value={draftStorageCapGb}
                onChange={(event) => onDraftStorageCapChange(Math.max(0.5, Number(event.currentTarget.value) || 0.5))}
              />
              <p className="field-help">
                If storage exceeds this cap, MemoryLane deletes the oldest days until usage drops.
              </p>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <svg className="settings-section-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <ellipse cx="10" cy="5.3" rx="5.4" ry="2.3" stroke="currentColor" strokeWidth="1.4" />
                <path d="M4.6 5.3v7.1c0 1.3 2.4 2.3 5.4 2.3s5.4-1 5.4-2.3V5.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M15.4 8.9c0 1.3-2.4 2.3-5.4 2.3s-5.4-1-5.4-2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Storage overview
            </h4>
            <span className="section-meta">{formatStorageValue(storageStats.usedGb)} used</span>
          </div>
          <div className="stat-stack">
            <div className="stat-row">
              <span>Used</span>
              <strong>{formatStorageValue(storageStats.usedGb)}</strong>
            </div>
            <div className="stat-row">
              <span>Cap</span>
              <strong>{storageStats.storageCapGb.toFixed(1)} GB</strong>
            </div>
          </div>
          <div className="usage-track" role="presentation">
            <span style={{ width: `${storageStats.usagePercent}%` }} />
          </div>

          <button className="secondary compact" type="button" onClick={onOpenCapturesFolder}>
            Open captures folder
          </button>

          <p className="path-readout">{storagePath}</p>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <svg className="settings-section-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path
                  d="M10 3.4 4.6 5.6v3.2c0 3.5 2.3 6.7 5.4 7.8 3.1-1.1 5.4-4.3 5.4-7.8V5.6L10 3.4Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path d="m7.7 9.7 1.7 1.7 2.9-2.9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Encrypted backup
            </h4>
          </div>

          <label className="field-block" htmlFor="backup-passphrase">
            <span>Backup passphrase</span>
            <input
              id="backup-passphrase"
              type="password"
              value={backupPassphrase}
              placeholder="At least 8 characters"
              onChange={(event) => onBackupPassphraseChange(event.currentTarget.value)}
            />
            <p className="field-help">Used to encrypt exports and decrypt imports locally.</p>
          </label>

          <label className="field-block" htmlFor="backup-import-path">
            <span>Import backup path (.mlbk)</span>
            <input
              id="backup-import-path"
              type="text"
              value={backupImportPath}
              placeholder="C:/path/to/memorylane_backup_YYYYMMDD_HHMMSS.mlbk"
              onChange={(event) => onBackupImportPathChange(event.currentTarget.value)}
            />
          </label>

          <div className="settings-backup-actions">
            <button className="secondary compact" type="button" onClick={onExportBackup} disabled={isBackupBusy}>
              {isBackupBusy ? "Working..." : "Export encrypted backup"}
            </button>
            <button className="secondary compact" type="button" onClick={onImportBackup} disabled={isBackupBusy}>
              {isBackupBusy ? "Working..." : "Import encrypted backup"}
            </button>
            <button
              className="secondary compact"
              type="button"
              onClick={onReindexAllCaptures}
              disabled={isReindexBusy || !ocrHealth.engineAvailable}
            >
              {isReindexBusy ? "Reindexing OCR..." : "Reindex OCR for all captures"}
            </button>
          </div>

          {maintenanceStage ? <p className="storage-meta">{maintenanceStage}</p> : null}
          {maintenanceProgress > 0 ? (
            <div className="usage-track maintenance-track" role="presentation">
              <span style={{ width: `${Math.max(1, Math.min(100, maintenanceProgress))}%` }} />
            </div>
          ) : null}

          {!ocrHealth.engineAvailable ? <p className="storage-meta warning">{ocrHealth.statusMessage}</p> : null}
          {ocrReindexStatus ? (
            <p
              className={
                ocrReindexStatusTone === "error"
                  ? "storage-meta warning"
                  : ocrReindexStatusTone === "success"
                    ? "storage-meta success"
                    : "storage-meta"
              }
            >
              {ocrReindexStatus}
            </p>
          ) : null}
          {backupStatus ? (
            <p className={backupStatusTone === "error" ? "storage-meta warning" : backupStatusTone === "success" ? "storage-meta success" : "storage-meta"}>
              {backupStatus}
            </p>
          ) : null}
        </section>

        <div className="settings-footer">
          <button className="secondary" type="button" onClick={onResetDraft} disabled={!settingsDirty}>
            Reset draft
          </button>
          <button className="secondary" type="button" onClick={onSaveSettings} disabled={!settingsDirty}>
            Save settings
          </button>
        </div>
      </section>
    </div>
  );
}

function ThemeOnboardingModal({
  isSaving,
  selectedThemeId,
  themeOptions,
  onConfirm,
  onSelectTheme,
}: ThemeOnboardingModalProps) {
  return (
    <div className="settings-overlay" role="presentation">
      <section
        className="panel settings-modal onboarding-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="theme-onboarding-title"
      >
        <div className="settings-modal-head">
          <div>
            <p className="section-title">Theme preference</p>
            <h3 id="theme-onboarding-title">Choose your default look</h3>
            <p className="section-meta">You can change this later from Settings.</p>
          </div>
        </div>

        <div className="theme-grid" role="listbox" aria-label="Onboarding theme options">
          {themeOptions.map((themeOption) => (
            <button
              key={themeOption.id}
              className={themeOption.id === selectedThemeId ? "theme-card active" : "theme-card"}
              type="button"
              role="option"
              aria-selected={themeOption.id === selectedThemeId}
              onClick={() => onSelectTheme(themeOption.id)}
              disabled={isSaving}
            >
              <span className="theme-card-head">
                <strong>{themeOption.name}</strong>
                <span>{themeOption.mood}</span>
              </span>
              <span className="theme-swatches" aria-hidden="true">
                {themeOption.swatches.map((swatch) => (
                  <span key={`${themeOption.id}-onboard-${swatch}`} style={{ backgroundColor: swatch }} />
                ))}
              </span>
            </button>
          ))}
        </div>

        <button className="secondary" type="button" onClick={onConfirm} disabled={isSaving}>
          {isSaving ? "Saving theme..." : "Apply theme and continue"}
        </button>
      </section>
    </div>
  );
}

function TimelineStrip({
  captures,
  hasNewerPages,
  hasOlderPages,
  hourMarkers,
  isPageLoading,
  loadedEndOffset,
  loadedStartOffset,
  onLoadNewer,
  onLoadOlder,
  onSelectCapture,
  onSelectCaptureAtIndex,
  searchQuery,
  selectedCaptureId,
  selectedCaptureIndex,
  selectedDayCaptureCount,
  thumbRefs,
  trailingSpacerWidth,
  leadingSpacerWidth,
  virtualCaptures,
}: TimelineStripProps) {
  return (
    <section className="panel timeline-strip">
      <div className="timeline-topbar">
        <div>
          <p className="section-title">Timeline</p>
          <h3>{formatRangeLabel(captures)}</h3>
        </div>

        <div className="timeline-meta">
          <span>
            {selectedDayCaptureCount > 0
              ? `Loaded ${loadedEndOffset > 0 ? loadedStartOffset + 1 : 0}-${loadedEndOffset} of ${selectedDayCaptureCount}`
              : "No captures yet"}
          </span>
          <strong>
            {searchQuery.trim().length > 0
              ? `${captures.length} filtered screenshot${captures.length === 1 ? "" : "s"}`
              : `${selectedDayCaptureCount} screenshots`}
          </strong>
        </div>
      </div>

      <div
        className="hour-markers"
        style={{ gridTemplateColumns: `repeat(${Math.max(hourMarkers.length, 1)}, minmax(0, 1fr))` }}
      >
        {(hourMarkers.length > 0 ? hourMarkers : ["Waiting for first capture"]).map((marker) => (
          <span key={marker}>{marker}</span>
        ))}
      </div>

      {captures.length === 0 ? (
        <div className="timeline-empty">
          <p>No screenshots in this timeline view.</p>
          <p className="muted">Try changing day or search query.</p>
        </div>
      ) : (
        <>
          <div className="timeline-scroll-shell">
            <button
              className="secondary compact"
              type="button"
              onClick={onLoadOlder}
              disabled={!hasOlderPages || isPageLoading}
            >
              older
            </button>

            <div className="timeline-thumbnails">
              {leadingSpacerWidth > 0 ? <div className="timeline-spacer" style={{ width: `${leadingSpacerWidth}px` }} /> : null}
              {virtualCaptures.map((capture) => (
                <button
                  key={capture.id}
                  ref={(element) => {
                    thumbRefs.current[capture.id] = element;
                  }}
                  className={capture.id === selectedCaptureId ? "timeline-thumb active" : "timeline-thumb"}
                  type="button"
                  onClick={() => onSelectCapture(capture.id)}
                >
                  <div className="thumb-preview" aria-hidden="true">
                    <img className="thumb-image" src={capture.thumbnailDataUrl} alt="" />
                  </div>
                  <span className="thumb-time">{capture.timestampLabel}</span>
                </button>
              ))}
              {trailingSpacerWidth > 0 ? <div className="timeline-spacer" style={{ width: `${trailingSpacerWidth}px` }} /> : null}
            </div>

            <button
              className="secondary compact"
              type="button"
              onClick={onLoadNewer}
              disabled={!hasNewerPages || isPageLoading}
            >
              newer
            </button>
          </div>

          <input
            className="timeline-range"
            type="range"
            min={0}
            max={captures.length - 1}
            value={Math.max(0, selectedCaptureIndex)}
            onChange={(event) => onSelectCaptureAtIndex(Number(event.currentTarget.value))}
          />
        </>
      )}
    </section>
  );
}

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
  const [captureSearchQuery, setCaptureSearchQuery] = useState<string>("");
  const [retrievalResults, setRetrievalResults] = useState<RetrievalSearchResult[]>([]);
  const [isRetrievalLoading, setIsRetrievalLoading] = useState<boolean>(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [activeRetrievalResultIndex, setActiveRetrievalResultIndex] = useState<number>(-1);
  const [dayIntelligence, setDayIntelligence] = useState<DayIntelligencePayload | null>(null);
  const [isDayIntelligenceLoading, setIsDayIntelligenceLoading] = useState<boolean>(false);
  const [dayIntelligenceError, setDayIntelligenceError] = useState<string | null>(null);
  const [performanceSnapshot, setPerformanceSnapshot] = useState<PerformanceSnapshotPayload>({
    lastSearchMs: 0,
    lastIntelligenceMs: 0,
    searchCacheHits: 0,
    intelligenceCacheHits: 0,
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
  const [isWindowMaximized, setIsWindowMaximized] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string>("Loading MemoryLane services...");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [clockMs, setClockMs] = useState<number>(Date.now());

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

  const normalizedSearch = captureSearchQuery.trim().toLowerCase();
  const retrievalResultIdSet = useMemo(
    () => new Set(retrievalResults.map((result) => result.captureId)),
    [retrievalResults],
  );

  const filteredCaptures = useMemo(() => {
    if (normalizedSearch.length === 0) {
      return captures;
    }

    if (retrievalResults.length > 0) {
      return captures.filter((capture) => retrievalResultIdSet.has(capture.id));
    }

    return captures.filter((capture) => {
      const haystack = [
        capture.timestampLabel,
        capture.capturedAt,
        capture.dayKey,
        formatViewerDate(capture.dayKey),
        capture.captureNote,
        capture.ocrText,
        capture.windowTitle,
        capture.processName,
        capture.tags.join(" "),
        capture.isBookmarked ? "bookmarked" : "",
        capture.isFavorite ? "favorite" : "",
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [captures, normalizedSearch, retrievalResultIdSet, retrievalResults.length]);

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

  useEffect(() => {
    let disposed = false;
    const query = captureSearchQuery.trim();

    if (query.length < 2) {
      setRetrievalResults([]);
      setRetrievalError(null);
      setIsRetrievalLoading(false);
      setActiveRetrievalResultIndex(-1);
      return () => {
        disposed = true;
      };
    }

    setIsRetrievalLoading(true);
    setRetrievalError(null);
    setRetrievalResults([]);
    setActiveRetrievalResultIndex(-1);

    const timeoutId = window.setTimeout(() => {
      const loadResults = async () => {
        try {
          const results = await invoke<RetrievalSearchResult[]>("search_captures", {
            query,
            limit: 20,
          });

          if (!disposed) {
            setRetrievalResults(results);
            setActiveRetrievalResultIndex(results.length > 0 ? 0 : -1);
          }
        } catch {
          if (!disposed) {
            setRetrievalError("Archive search unavailable right now.");
          }
        } finally {
          if (!disposed) {
            setIsRetrievalLoading(false);
          }

          try {
            const snapshot = await invoke<PerformanceSnapshotPayload>("get_performance_snapshot");
            if (!disposed) {
              setPerformanceSnapshot(snapshot);
            }
          } catch {
            // Ignore snapshot refresh errors.
          }
        }
      };

      void loadResults();
    }, 180);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [captureSearchQuery]);

  useEffect(() => {
    let disposed = false;

    if (!isDayKey(selectedDayKey)) {
      setDayIntelligence(null);
      setDayIntelligenceError(null);
      setIsDayIntelligenceLoading(false);
      return () => {
        disposed = true;
      };
    }

    setIsDayIntelligenceLoading(true);
    setDayIntelligenceError(null);

    const timeoutId = window.setTimeout(() => {
      const loadDayIntelligence = async () => {
        try {
          const payload = await invoke<DayIntelligencePayload>("get_day_intelligence", {
            dayKey: selectedDayKey,
          });

          if (!disposed) {
            setDayIntelligence(payload);
          }
        } catch {
          if (!disposed) {
            setDayIntelligenceError("Day summary unavailable right now.");
          }
        } finally {
          if (!disposed) {
            setIsDayIntelligenceLoading(false);
          }
        }

        try {
          const snapshot = await invoke<PerformanceSnapshotPayload>("get_performance_snapshot");
          if (!disposed) {
            setPerformanceSnapshot(snapshot);
          }
        } catch {
          // Ignore snapshot refresh errors.
        }
      };

      void loadDayIntelligence();
    }, 140);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [captures.length, selectedDayKey]);

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

    const shouldRedact = window.confirm(
      "Redact this capture image and metadata? This will overwrite the screenshot preview with a redacted version.",
    );

    if (!shouldRedact) {
      return;
    }

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
  }, [refreshAll, selectedCapture]);

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
      setThemeId(resolveThemeId(updated.themeId));
      setExcludedProcesses(updated.excludedProcesses ?? []);
      setExcludedWindowKeywords(updated.excludedWindowKeywords ?? []);
      setPauseProcesses(updated.pauseProcesses ?? []);
      setPauseWindowKeywords(updated.pauseWindowKeywords ?? []);
      setSensitiveWindowKeywords(updated.sensitiveWindowKeywords ?? []);
      setSensitiveCaptureMode(resolveSensitiveCaptureMode(updated.sensitiveCaptureMode));
      await refreshAll(selectedDayKeyRef.current);
      setActionMessage(
        `Settings saved. Capturing every ${updated.intervalMinutes} minute(s) with ${themeName(resolveThemeId(updated.themeId))}. Privacy mode: ${resolveSensitiveCaptureMode(updated.sensitiveCaptureMode)}.`,
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
    refreshAll,
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

    const shouldDelete = window.confirm(
      `Delete this screenshot from ${selectedCapture.timestampLabel}? This removes the image and thumbnail files.`,
    );

    if (!shouldDelete) {
      return;
    }

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
  }, [clearCompareAnchor, compareCaptureRef?.captureId, refreshAll, selectedCapture]);

  const deleteSelectedDay = useCallback(async () => {
    if (selectedDaySummary.captureCount === 0) {
      setActionMessage("There are no captures to delete for this day.");
      return;
    }

    const shouldDelete = window.confirm(
      `Delete every screenshot from ${formatViewerDate(selectedDaySummary.dayKey)}? This cannot be undone.`,
    );

    if (!shouldDelete) {
      return;
    }

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
  }, [clearCompareAnchor, compareCaptureRef?.dayKey, refreshAll, selectedDaySummary, todayKey]);

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
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
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
            void jumpThroughRetrievalResults(event.shiftKey ? -1 : 1);
          }
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
    shiftCapture,
    shiftDay,
    isThemeOnboardingOpen,
    isSettingsOpen,
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
      <div className="desktop-titleband">
        <div className="desktop-titleband-drag" data-tauri-drag-region onDoubleClick={handleWindowToggleMaximize}>
          <span className="desktop-window-title">MemoryLane</span>
        </div>

        <WindowControls
          isWindowMaximized={isWindowMaximized}
          onCloseWindow={handleWindowClose}
          onMinimizeWindow={handleWindowMinimize}
          onToggleWindowMaximize={handleWindowToggleMaximize}
        />
      </div>

      <div className="app-shell">
        <TopBar
          hasNextDay={hasNextDay}
          hasPreviousDay={hasPreviousDay}
          isWindowMaximized={isWindowMaximized}
          isJumpToNowDisabled={!isTodaySelected || filteredCaptures.length === 0}
          isRecording={isRecording}
          selectedDayCaptureCount={selectedDayCaptureCount}
          selectedDayKey={selectedDayKey}
          selectedDayLabel={selectedDayLabel}
          todayKey={todayKey}
          onJumpToNow={jumpToNow}
          onOpenSettings={() => setIsSettingsOpen(true)}
          onSelectDay={setSelectedDayKey}
          onSelectNextDay={() => shiftDay(-1)}
          onSelectPreviousDay={() => shiftDay(1)}
          onToggleWindowMaximize={handleWindowToggleMaximize}
        />

        <DayRail
          recentDays={recentDays}
          selectedDayKey={selectedDayKey}
          todayKey={todayKey}
          onJumpToToday={() => void jumpToToday()}
          onSelectDay={setSelectedDayKey}
        />

        <ViewerPane
          actionMessage={actionMessage}
          captureHealth={captureHealth}
          captures={filteredCaptures}
          compareCaptureLabel={compareCaptureLabel}
          compareImageDataUrl={compareImageDataUrl}
          contextBadge={contextBadge}
          isFilterActive={normalizedSearch.length > 0}
          onCopyPath={() => void copySelectedCapturePath()}
          onClearCompareAnchor={clearCompareAnchor}
          onDeleteCapture={() => void deleteSelectedCapture()}
          onOpenCapturesFolder={() => void openCapturesFolder()}
          onRedactCapture={() => void redactSelectedCapture()}
          onSetCompareAnchor={setCompareAnchor}
          onSelectNext={() => shiftCapture(1)}
          onSelectPrevious={() => shiftCapture(-1)}
          onToggleBookmark={() => void toggleBookmark()}
          onToggleFavorite={() => void toggleFavorite()}
          selectedCapture={selectedCapture}
          selectedCaptureIndex={selectedCaptureIndex}
          selectedDayLabel={selectedDayLabel}
          selectedDaySummary={selectedDaySummary}
          selectedImageDataUrl={selectedImageDataUrl}
        />

        <UtilityRail
          activeRetrievalResultIndex={activeRetrievalResultIndex}
          captureSearchQuery={captureSearchQuery}
          compareCaptureLabel={compareCaptureLabel}
          dayIntelligence={dayIntelligence}
          dayIntelligenceError={dayIntelligenceError}
          dayIntelligenceLoading={isDayIntelligenceLoading}
          intervalMinutes={intervalMinutes}
          isReviewBusy={isReviewBusy}
          isRetrievalLoading={isRetrievalLoading}
          isRecording={isRecording}
          nextCaptureLabel={nextCaptureLabel}
          noteDirty={noteDirty}
          noteDraft={noteDraft}
          noteSaveState={noteSaveState}
          ocrHealth={ocrHealth}
          performanceSnapshot={performanceSnapshot}
          retrievalError={retrievalError}
          retrievalResults={retrievalResults}
          onCaptureNow={() => void triggerCaptureNow()}
          onClearCompareAnchor={clearCompareAnchor}
          onDeleteDay={() => void deleteSelectedDay()}
          onJumpToReviewCapture={(captureId) => void jumpToReviewCapture(captureId)}
          onApplyTagFilter={applyTagFilter}
          onNoteDraftChange={setNoteDraft}
          onTagDraftChange={setTagDraft}
          onRedactCapture={() => void redactSelectedCapture()}
          onSaveTags={() => void saveCaptureTags()}
          onSetCompareAnchor={setCompareAnchor}
          onSaveNote={() => void saveCaptureNote()}
          onSelectSearchResult={(result) => {
            const resultIndex = retrievalResults.findIndex((item) => item.captureId === result.captureId);
            if (resultIndex >= 0) {
              setActiveRetrievalResultIndex(resultIndex);
            }
            void jumpToRetrievalResult(result);
          }}
          onSearchQueryChange={setCaptureSearchQuery}
          onTogglePause={() => void togglePauseResume()}
          onToggleBookmark={() => void toggleBookmark()}
          onToggleFavorite={() => void toggleFavorite()}
          reviewShortcuts={reviewShortcuts}
          searchInputRef={searchInputRef}
          selectedCapture={selectedCapture}
          selectedDaySummary={selectedDaySummary}
          storageStats={storageStats}
          tagDraft={tagDraft}
          todayCaptureCount={todayCaptureCount}
        />

        <TimelineStrip
          captures={filteredCaptures}
          hasNewerPages={hasNewerPages}
          hasOlderPages={hasOlderPages}
          hourMarkers={hourMarkers}
          isPageLoading={isPageLoading}
          loadedEndOffset={loadedEndOffset}
          loadedStartOffset={loadedStartOffset}
          onLoadNewer={() => void loadNewerPage()}
          onLoadOlder={() => void loadOlderPage()}
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
          onExportBackup={() => void exportEncryptedBackup()}
          onImportBackup={() => void importEncryptedBackup()}
          onReindexAllCaptures={() => void reindexAllCaptures()}
          onOpenCapturesFolder={() => void openCapturesFolder()}
          onResetDraft={resetSettingsDraft}
          onSaveSettings={() => void saveSettingsFromModal()}
          settingsDirty={settingsDirty}
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
    </div>
  );
}

export default App;

