import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
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

type CaptureRecord = {
  id: number;
  dayKey: string;
  capturedAt: string;
  timestampLabel: string;
  imagePath: string;
  thumbnailDataUrl: string;
  captureNote: string;
  width: number;
  height: number;
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

type TopBarProps = {
  hasNextDay: boolean;
  hasPreviousDay: boolean;
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
  contextBadge: string;
  isFilterActive: boolean;
  onCopyPath: () => void;
  onDeleteCapture: () => void;
  onOpenCapturesFolder: () => void;
  onSelectNext: () => void;
  onSelectPrevious: () => void;
  selectedCapture: CaptureRecord | null;
  selectedCaptureIndex: number;
  selectedDayLabel: string;
  selectedDaySummary: DaySummary;
  selectedImageDataUrl: string | null;
};

type UtilityRailProps = {
  captureSearchQuery: string;
  intervalMinutes: number;
  isRecording: boolean;
  nextCaptureLabel: string;
  noteDirty: boolean;
  noteDraft: string;
  noteSaveState: NoteSaveState;
  onCaptureNow: () => void;
  onDeleteDay: () => void;
  onNoteDraftChange: (nextValue: string) => void;
  onSaveNote: () => void;
  onSearchQueryChange: (nextValue: string) => void;
  onTogglePause: () => void;
  selectedCapture: CaptureRecord | null;
  selectedDaySummary: DaySummary;
  storageStats: StorageStatsPayload;
  todayCaptureCount: number;
};

type SettingsModalProps = {
  draftIntervalMinutes: number;
  draftRetentionDays: number;
  draftStorageCapGb: number;
  intervalMinutes: number;
  onClose: () => void;
  onDraftIntervalChange: (nextValue: number) => void;
  onDraftRetentionChange: (nextValue: number) => void;
  onDraftStorageCapChange: (nextValue: number) => void;
  onOpenCapturesFolder: () => void;
  onSaveSettings: () => void;
  retentionDays: number;
  storageCapGb: number;
  storagePath: string;
  storageStats: StorageStatsPayload;
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

  const pathChunks = capture.imagePath.split(/[\\/]/);
  const fileName = pathChunks[pathChunks.length - 1] ?? "capture";
  return `Window context pending · ${fileName}`;
}

function densityMiniBars(density: number[]): number[] {
  const values = density.length > 0 ? density : EMPTY_DENSITY;
  return [values[0] ?? 0.1, values[3] ?? 0.2, values[7] ?? 0.1];
}

function dayCode(dayKey: string): string {
  const label = formatDayLabel(dayKey);

  if (label === "Today") {
    return "TOD";
  }

  if (label === "Yesterday") {
    return "YES";
  }

  return label.slice(0, 3).toUpperCase();
}

function TopBar({
  hasNextDay,
  hasPreviousDay,
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
}: TopBarProps) {
  return (
    <header className="panel topbar">
      <div className="topbar-brand">
        <img src="/memorylane_logo.jpg" alt="" aria-hidden="true" />
        <strong>MemoryLane</strong>
        <span className={isRecording ? "status-pill recording" : "status-pill paused"}>
          {isRecording ? "recording" : "paused"}
        </span>
      </div>

      <div className="topbar-main-controls">
        <button className="secondary compact" type="button" onClick={onSelectPreviousDay} disabled={!hasPreviousDay}>
          ← prev
        </button>

        <div className="topbar-day-summary">
          <h1>{selectedDayLabel}</h1>
          <p>{selectedDayCaptureCount} captures</p>
        </div>

        <button className="secondary compact" type="button" onClick={onSelectNextDay} disabled={!hasNextDay}>
          next →
        </button>
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

        <button className="secondary" type="button" onClick={onJumpToNow} disabled={isJumpToNowDisabled}>
          jump to now
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

function DayRail({ recentDays, selectedDayKey, todayKey, onJumpToToday, onSelectDay }: DayRailProps) {
  return (
    <aside className="panel day-rail">
      <button className="day-rail-entry today" type="button" onClick={onJumpToToday} title={`Jump to ${formatViewerDate(todayKey)}`}>
        <span className="day-rail-number">•</span>
        <span className="day-rail-code">NOW</span>
      </button>

      <div className="day-rail-list">
        {recentDays.map((day) => {
          const isSelected = day.dayKey === selectedDayKey;
          const bars = densityMiniBars(day.density);

          return (
            <button
              key={day.dayKey}
              className={isSelected ? "day-rail-entry selected" : "day-rail-entry"}
              type="button"
              title={`${formatViewerDate(day.dayKey)} · ${day.captureCount} captures`}
              onClick={() => onSelectDay(day.dayKey)}
            >
              <span className="day-rail-number">{dayDateFromKey(day.dayKey).getDate()}</span>
              <span className="day-rail-code">{dayCode(day.dayKey)}</span>
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
  contextBadge,
  isFilterActive,
  onCopyPath,
  onDeleteCapture,
  onOpenCapturesFolder,
  onSelectNext,
  onSelectPrevious,
  selectedCapture,
  selectedCaptureIndex,
  selectedDayLabel,
  selectedDaySummary,
  selectedImageDataUrl,
}: ViewerPaneProps) {
  const hasCaptures = Boolean(selectedCapture && captures.length > 0);

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
              </div>

              <div className="overlay-actions">
                <button className="secondary compact" type="button" onClick={onOpenCapturesFolder}>
                  open folder
                </button>
                <button className="secondary compact" type="button" onClick={onCopyPath}>
                  copy path
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
  captureSearchQuery,
  intervalMinutes,
  isRecording,
  nextCaptureLabel,
  noteDirty,
  noteDraft,
  noteSaveState,
  onCaptureNow,
  onDeleteDay,
  onNoteDraftChange,
  onSaveNote,
  onSearchQueryChange,
  onTogglePause,
  selectedCapture,
  selectedDaySummary,
  storageStats,
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

  return (
    <aside className="panel utility-rail">
      <section className="utility-section">
        <h3>TODAY</h3>
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
        <h3>SEARCH CAPTURES</h3>
        <input
          type="text"
          value={captureSearchQuery}
          placeholder="filter by time or keyword..."
          onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
        />
      </section>

      <section className="utility-section">
        <div className="section-row">
          <h3>NOTE THIS CAPTURE</h3>
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
        <h3>RECORDING</h3>
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
        <h3>STORAGE</h3>
        <div className="usage-track" role="presentation">
          <span style={{ width: `${storageStats.usagePercent}%` }} />
        </div>
        <p className="storage-meta">
          {formatStorageValue(storageStats.usedGb)} used · {storageStats.storageCapGb.toFixed(1)} GB cap
        </p>
      </section>

      <section className="utility-section">
        <h3>DAY ACTIONS</h3>
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
  draftIntervalMinutes,
  draftRetentionDays,
  draftStorageCapGb,
  intervalMinutes,
  onClose,
  onDraftIntervalChange,
  onDraftRetentionChange,
  onDraftStorageCapChange,
  onOpenCapturesFolder,
  onSaveSettings,
  retentionDays,
  storageCapGb,
  storagePath,
  storageStats,
}: SettingsModalProps) {
  const settingsDirty =
    draftIntervalMinutes !== intervalMinutes ||
    draftRetentionDays !== retentionDays ||
    Number(draftStorageCapGb.toFixed(1)) !== Number(storageCapGb.toFixed(1));

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
            <h3 id="settings-modal-title">Capture and storage</h3>
            <p className="section-meta">{storageStats.captureCount} total captures</p>
          </div>
          <button className="secondary compact" type="button" onClick={onClose}>
            Close
          </button>
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

        <div className="field-grid">
          <label className="field-block" htmlFor="interval-minutes">
            <span>Capture cadence (minutes)</span>
            <p className="field-help">
              Presets are quick picks. Use custom minutes below to set any interval between {INTERVAL_MIN_MINUTES} and {INTERVAL_MAX_MINUTES}.
            </p>
            <div className="interval-grid">
              {INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option}
                  className={option === draftIntervalMinutes ? "interval-btn active" : "interval-btn"}
                  type="button"
                  onClick={() => onDraftIntervalChange(option)}
                >
                  {option} min
                </button>
              ))}
            </div>
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
          </label>

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

        <div className="utility-actions compact-stack">
          <button className="secondary" type="button" onClick={onSaveSettings} disabled={!settingsDirty}>
            Save settings
          </button>
          <button className="secondary" type="button" onClick={onOpenCapturesFolder}>
            Open captures folder
          </button>
        </div>

        <p className="path-readout">{storagePath}</p>
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
  const [retentionDays, setRetentionDays] = useState<number>(30);
  const [storageCapGb, setStorageCapGb] = useState<number>(5);
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
  const [captureSearchQuery, setCaptureSearchQuery] = useState<string>("");
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [noteSaveState, setNoteSaveState] = useState<NoteSaveState>("idle");
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);
  const [actionMessage, setActionMessage] = useState<string>("Loading MemoryLane services...");
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [clockMs, setClockMs] = useState<number>(Date.now());

  const selectedDayKeyRef = useRef(selectedDayKey);
  const timelineThumbRefs = useRef<Record<number, HTMLButtonElement | null>>({});

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
  }, [intervalMinutes]);

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

  const filteredCaptures = useMemo(() => {
    if (normalizedSearch.length === 0) {
      return captures;
    }

    return captures.filter((capture) => {
      const haystack = [
        capture.timestampLabel,
        capture.capturedAt,
        capture.dayKey,
        formatViewerDate(capture.dayKey),
        capture.captureNote,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(normalizedSearch);
    });
  }, [captures, normalizedSearch]);

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
    const [settings, stats, health] = await Promise.all([
      invoke<SettingsPayload>("get_settings"),
      invoke<StorageStatsPayload>("get_storage_stats"),
      invoke<CaptureHealthPayload>("get_capture_health"),
    ]);

    setIntervalMinutes(settings.intervalMinutes);
    setRetentionDays(settings.retentionDays);
    setStorageCapGb(settings.storageCapGb);
    setIsRecording(!settings.isPaused);
    setStorageStats(stats);
    setCaptureHealth(health);
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
      await Promise.all([refreshSettingsAndStats(), refreshStoragePath()]);
      const { summaries, nextDayKey } = await refreshDaySummaries(fallbackDayKey);
      const total = summaries.find((day) => day.dayKey === nextDayKey)?.captureCount ?? 0;
      await initializeDayCaptures(nextDayKey, total);
    },
    [initializeDayCaptures, refreshDaySummaries, refreshSettingsAndStats, refreshStoragePath],
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
    if (!selectedCapture) {
      setNoteDraft("");
      setNoteSaveState("idle");
      return;
    }

    setNoteDraft(selectedCapture.captureNote ?? "");
    setNoteSaveState("idle");
  }, [selectedCapture?.id, selectedCapture?.captureNote]);

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
      setActionMessage("Captured the current screen and refreshed the timeline.");
    } catch {
      setActionMessage("Capture command failed. Check screen permissions and runtime logs.");
    }
  }, [refreshAll]);

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

    try {
      const updated = await invoke<SettingsPayload>("update_settings", {
        intervalMinutes: intervalTarget,
        retentionDays: retentionTarget,
        storageCapGb: capTarget,
      });

      setIntervalMinutes(updated.intervalMinutes);
      setRetentionDays(updated.retentionDays);
      setStorageCapGb(updated.storageCapGb);
      await refreshAll(selectedDayKeyRef.current);
      setActionMessage(`Settings saved. Capturing every ${updated.intervalMinutes} minute(s).`);
      return true;
    } catch {
      setActionMessage("Unable to save settings.");
      return false;
    }
  }, [draftIntervalMinutes, draftRetentionDays, draftStorageCapGb, refreshAll]);

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
      await refreshAll(payload.dayKey);
      setActionMessage(`Deleted capture and ${payload.removedFiles} file(s) from ${formatDaySecondary(payload.dayKey)}.`);
    } catch {
      setActionMessage("Delete capture action failed.");
    }
  }, [refreshAll, selectedCapture]);

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
      await refreshAll(todayKey);
      setActionMessage(
        `Deleted ${payload.removedRows} captures and ${payload.removedFiles} files from ${formatViewerDate(payload.dayKey)}.`,
      );
    } catch {
      setActionMessage("Delete day action failed.");
    }
  }, [refreshAll, selectedDaySummary, todayKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      if (event.ctrlKey || event.metaKey || event.altKey) {
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
    deleteSelectedCapture,
    jumpToFirstCapture,
    jumpToNow,
    jumpToToday,
    loadNewerPage,
    loadOlderPage,
    openCapturesFolder,
    shiftCapture,
    shiftDay,
    isSettingsOpen,
    togglePauseResume,
    triggerCaptureNow,
  ]);

  const selectedDayIndex = navigationDays.findIndex((day) => day.dayKey === selectedDayKey);
  const hasPreviousDay = selectedDayIndex >= 0 && selectedDayIndex < navigationDays.length - 1;
  const hasNextDay = selectedDayIndex > 0;
  const selectedDayLabel = formatViewerDate(selectedDaySummary.dayKey);
  const contextBadge = deriveContextBadge(selectedCapture);
  const noteDirty = selectedCapture ? noteDraft !== selectedCapture.captureNote : false;

  return (
    <div className="memorylane-root">
      <div className="app-shell">
        <TopBar
          hasNextDay={hasNextDay}
          hasPreviousDay={hasPreviousDay}
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
          contextBadge={contextBadge}
          isFilterActive={normalizedSearch.length > 0}
          onCopyPath={() => void copySelectedCapturePath()}
          onDeleteCapture={() => void deleteSelectedCapture()}
          onOpenCapturesFolder={() => void openCapturesFolder()}
          onSelectNext={() => shiftCapture(1)}
          onSelectPrevious={() => shiftCapture(-1)}
          selectedCapture={selectedCapture}
          selectedCaptureIndex={selectedCaptureIndex}
          selectedDayLabel={selectedDayLabel}
          selectedDaySummary={selectedDaySummary}
          selectedImageDataUrl={selectedImageDataUrl}
        />

        <UtilityRail
          captureSearchQuery={captureSearchQuery}
          intervalMinutes={intervalMinutes}
          isRecording={isRecording}
          nextCaptureLabel={nextCaptureLabel}
          noteDirty={noteDirty}
          noteDraft={noteDraft}
          noteSaveState={noteSaveState}
          onCaptureNow={() => void triggerCaptureNow()}
          onDeleteDay={() => void deleteSelectedDay()}
          onNoteDraftChange={setNoteDraft}
          onSaveNote={() => void saveCaptureNote()}
          onSearchQueryChange={setCaptureSearchQuery}
          onTogglePause={() => void togglePauseResume()}
          selectedCapture={selectedCapture}
          selectedDaySummary={selectedDaySummary}
          storageStats={storageStats}
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
          draftIntervalMinutes={draftIntervalMinutes}
          draftRetentionDays={draftRetentionDays}
          draftStorageCapGb={draftStorageCapGb}
          intervalMinutes={intervalMinutes}
          onClose={() => setIsSettingsOpen(false)}
          onDraftIntervalChange={setDraftIntervalMinutes}
          onDraftRetentionChange={setDraftRetentionDays}
          onDraftStorageCapChange={setDraftStorageCapGb}
          onOpenCapturesFolder={() => void openCapturesFolder()}
          onSaveSettings={() => void saveSettingsFromModal()}
          retentionDays={retentionDays}
          storageCapGb={storageCapGb}
          storagePath={storagePath}
          storageStats={storageStats}
        />
      ) : null}
    </div>
  );
}

export default App;

