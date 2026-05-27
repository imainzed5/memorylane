export type DaySummary = {
  dayKey: string;
  captureCount: number;
  density: number[];
  firstCaptureAt: string | null;
  lastCaptureAt: string | null;
};

export type CaptureRecord = {
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

export type RetrievalSearchResult = {
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

export type DayFocusBlock = {
  startTimestampLabel: string;
  endTimestampLabel: string;
  captureCount: number;
  dominantContext: string;
};

export type DayIntelligencePayload = {
  dayKey: string;
  summary: string;
  focusBlocks: DayFocusBlock[];
  changeHighlights: string[];
  topTerms: string[];
  generatedAt: string;
  generationMs: number;
};

export type ImportBackupPayload = {
  captureCount: number;
  dayCount: number;
  restoredAt: string;
};

export type PerformanceSnapshotPayload = {
  lastSearchMs: number;
  lastIntelligenceMs: number;
  searchCacheHits: number;
  intelligenceCacheHits: number;
};

export type CaptureContextPagePayload = {
  dayKey: string;
  totalCaptures: number;
  offset: number;
  focusedCaptureId: number;
  captures: CaptureRecord[];
};

export type CaptureImagePayload = {
  id: number;
  imageDataUrl: string;
};

export type CaptureHealthPayload = {
  consecutiveFailures: number;
  lastError: string | null;
};

export type OcrHealthPayload = {
  engineAvailable: boolean;
  statusMessage: string;
  executablePath: string | null;
};

export type ReindexCapturesPayload = {
  queuedCount: number;
  queuedAt: string;
};

export type CaptureErrorEventPayload = {
  message: string;
};

export type SettingsPayload = {
  intervalMinutes: number;
  retentionDays: number;
  storageCapGb: number;
  isPaused: boolean;
  startupOnBoot: boolean;
  startupOnBootSupported: boolean;
  themeId: string;
  excludedProcesses: string[];
  excludedWindowKeywords: string[];
  pauseProcesses: string[];
  pauseWindowKeywords: string[];
  sensitiveWindowKeywords: string[];
  sensitiveCaptureMode: string;
};

export type SensitiveCaptureMode = "skip" | "redact" | "pause";

export type CaptureReviewPayload = {
  captureId: number;
  isBookmarked: boolean;
  isFavorite: boolean;
  tags: string[];
};

export type ReviewShortcutCapture = {
  captureId: number;
  dayKey: string;
  capturedAt: string;
  timestampLabel: string;
  tags: string[];
};

export type ReviewTagShortcut = {
  tag: string;
  captureCount: number;
  latestCaptureId: number;
  latestDayKey: string;
  latestTimestampLabel: string;
};

export type ReviewShortcutsPayload = {
  bookmarks: ReviewShortcutCapture[];
  favorites: ReviewShortcutCapture[];
  tags: ReviewTagShortcut[];
};

export type CaptureSuppressedEventPayload = {
  mode: string;
  reason: string;
  captured: boolean;
};

export type PauseStatePayload = {
  isPaused: boolean;
};

export type StorageStatsPayload = {
  usedBytes: number;
  usedGb: number;
  storageCapGb: number;
  usagePercent: number;
  captureCount: number;
};

export type DeleteCapturePayload = {
  captureId: number;
  dayKey: string;
  removedFiles: number;
};

export type DeleteDayPayload = {
  dayKey: string;
  removedRows: number;
  removedFiles: number;
};

export type NoteSaveState = "idle" | "saving" | "saved" | "error";

export type ThemeId = "amber-noir" | "obsidian-jade" | "arctic-slate" | "deep-plum" | "midnight-blue";

export type ThemeOption = {
  id: ThemeId;
  name: string;
  mood: string;
  swatches: [string, string, string, string];
};

export type WorkspaceMode = "browse" | "review" | "intelligence" | "all-captures" | "calendar";
