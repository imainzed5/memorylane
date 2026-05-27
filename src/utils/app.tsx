import type { ReactNode } from "react";
import type { CaptureRecord, DaySummary, SensitiveCaptureMode, ThemeId } from "../types";
import { EMPTY_DENSITY, INTERVAL_MAX_MINUTES, INTERVAL_MIN_MINUTES, LEGACY_THEME_ID, MATCH_SOURCE_LABELS, QUICKSTART_DISMISS_STORAGE_KEY, THEME_OPTIONS } from "../constants";

export function isThemeId(value: string): value is ThemeId {
  return THEME_OPTIONS.some((option) => option.id === value);
}

export function resolveThemeId(value: string | null | undefined): ThemeId {
  const normalized = (value ?? "").trim().toLowerCase();
  if (isThemeId(normalized)) {
    return normalized;
  }

  return LEGACY_THEME_ID;
}

export function resolveSensitiveCaptureMode(value: string | null | undefined): SensitiveCaptureMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "redact" || normalized === "pause") {
    return normalized;
  }

  return "skip";
}

export function parseListEditorText(value: string, maxItems = 24): string[] {
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

export function listToEditorText(values: string[]): string {
  return values.join(", ");
}

export function haveSameListValues(left: string[], right: string[]): boolean {
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

export function parseTagDraftInput(value: string): string[] {
  return parseListEditorText(value, 16).map((entry) => entry.slice(0, 32));
}

export function hasDismissedQuickStart(): boolean {
  try {
    return window.localStorage.getItem(QUICKSTART_DISMISS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markQuickStartDismissed(): void {
  try {
    window.localStorage.setItem(QUICKSTART_DISMISS_STORAGE_KEY, "1");
  } catch {
    // Ignore localStorage availability issues in restricted runtimes.
  }
}

export function themeName(themeId: ThemeId): string {
  return THEME_OPTIONS.find((option) => option.id === themeId)?.name ?? "Theme";
}

export function dayKeyFromDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dayDateFromKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function formatDaySecondary(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(dayDateFromKey(dayKey));
}

export function formatViewerDate(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(dayDateFromKey(dayKey));
}

export function formatTopBarDate(dayKey: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(dayDateFromKey(dayKey));
}

export function isDayKey(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function formatRangeLabel(captures: CaptureRecord[]): string {
  if (captures.length === 0) {
    return "Waiting for first capture";
  }

  return `${captures[0].timestampLabel} to ${captures[captures.length - 1].timestampLabel}`;
}

export function formatCaptureTimestamp(capturedAt: string): string {
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

export function formatCountdown(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function clampIntervalMinutes(value: number): number {
  return Math.max(INTERVAL_MIN_MINUTES, Math.min(INTERVAL_MAX_MINUTES, value));
}

export function formatStorageValue(usedGb: number): string {
  if (usedGb >= 10) {
    return `${usedGb.toFixed(1)} GB`;
  }

  return `${usedGb.toFixed(2)} GB`;
}

export function formatMatchSourceLabel(source: string): string {
  const normalized = source.trim().toLowerCase();
  return MATCH_SOURCE_LABELS[normalized] ?? normalized;
}

export function fallbackDays(): DaySummary[] {
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

export function mergeCaptures(existing: CaptureRecord[], incoming: CaptureRecord[]): CaptureRecord[] {
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

export function buildHourMarkers(captures: CaptureRecord[]): string[] {
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

export function deriveContextBadge(capture: CaptureRecord | null): string {
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

export function buildCaptureSearchText(capture: CaptureRecord): string {
  return [
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
}

export function renderHighlightedSnippet(snippet: string, highlightTerms: string[]): ReactNode {
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
