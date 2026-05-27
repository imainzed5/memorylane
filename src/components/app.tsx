import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bookmark,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Copy,
  Database,
  Filter,
  HardDrive,
  Info,
  Layers3,
  Maximize2,
  MoreHorizontal,
  Minus,
  Palette,
  Square,
  Power,
  Search,
  Share2,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  X,
  Trash2,
} from "lucide-react";
import type { CaptureHealthPayload, CaptureRecord, DayIntelligencePayload, DaySummary, NoteSaveState, OcrHealthPayload, PerformanceSnapshotPayload, RetrievalSearchResult, ReviewShortcutsPayload, SensitiveCaptureMode, StorageStatsPayload, ThemeId, ThemeOption, WorkspaceMode } from "../types";
import { ICON_SIZE, ICON_STROKE_WIDTH, INTERVAL_MAX_MINUTES, INTERVAL_MIN_MINUTES, INTERVAL_OPTIONS, SEARCH_SUGGESTIONS } from "../constants";
import { clampIntervalMinutes, dayDateFromKey, dayKeyFromDate, formatCaptureTimestamp, formatDaySecondary, formatMatchSourceLabel, formatRangeLabel, formatStorageValue, formatTopBarDate, formatViewerDate, renderHighlightedSnippet, resolveSensitiveCaptureMode } from "../utils/app";

type TopBarProps = {
  hasNextDay: boolean;
  hasPreviousDay: boolean;
  isWindowMaximized: boolean;
  isRecording: boolean;
  selectedDayCaptureCount: number;
  selectedDayKey: string;
  todayKey: string;
  onOpenReviewWorkspace: () => void;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
  onSelectDay: (dayKey: string) => void;
  onSelectNextDay: () => void;
  onSelectPreviousDay: () => void;
  onCloseWindow: () => void;
  onMinimizeWindow: () => void;
  onToggleWindowMaximize: () => void;
};

type DayRailProps = {
  workspaceMode: WorkspaceMode;
  recentDays: DaySummary[];
  selectedDayKey: string;
  todayKey: string;
  onApplyStructuredFilter: (query: string) => void;
  onFocusSearch: () => void;
  onOpenBrowseWorkspace: () => void;
  onOpenIntelligenceWorkspace: () => void;
  onOpenReviewWorkspace: () => void;
  onOpenAllCapturesWorkspace: () => void;
  onOpenCalendarWorkspace: () => void;
  onSelectDay: (dayKey: string) => void;
  onShowDayTooltip?: (e: React.MouseEvent, dayKey: string, captureCount: number) => void;
  onHideDayTooltip?: () => void;
};

type ViewerPaneProps = {
  actionMessage: string;
  captureHealth: CaptureHealthPayload;
  captures: CaptureRecord[];
  compareCaptureLabel: string | null;
  compareImageDataUrl: string | null;
  contextBadge: string;
  isFilterActive: boolean;
  onCaptureNow: () => void;
  onClearSearch: () => void;
  onCopyPath: () => void;
  onClearCompareAnchor: () => void;
  onDeleteCapture: () => void;
  onOpenSettings: () => void;
  onOpenCapturesFolder: () => void;
  onRedactCapture: () => void;
  onSetCompareAnchor: () => void;
  onSelectNext: () => void;
  onSelectPrevious: () => void;
  onSelectFirst: () => void;
  onSelectLast: () => void;
  onToggleFullscreen: () => void;
  onToggleBookmark: () => void;
  onToggleFavorite: () => void;
  selectedCapture: CaptureRecord | null;
  selectedCaptureIndex: number;
  selectedDayLabel: string;
  selectedDaySummary: DaySummary;
  selectedImageDataUrl: string | null;
};

type ReviewWorkspaceProps = {
  compareCaptureLabel: string | null;
  isReviewBusy: boolean;
  noteDirty: boolean;
  noteDraft: string;
  noteSaveState: NoteSaveState;
  onApplyTagFilter: (tag: string) => void;
  onClearCompareAnchor: () => void;
  onJumpToReviewCapture: (captureId: number) => void;
  onNoteDraftChange: (nextValue: string) => void;
  onOpenBrowseWorkspace: () => void;
  onOpenIntelligenceWorkspace: () => void;
  onRedactCapture: () => void;
  onSaveNote: () => void;
  onSaveTags: () => void;
  onSetCompareAnchor: () => void;
  onTagDraftChange: (nextValue: string) => void;
  onToggleBookmark: () => void;
  onToggleFavorite: () => void;
  reviewShortcuts: ReviewShortcutsPayload;
  selectedCapture: CaptureRecord | null;
  selectedDayLabel: string;
  tagDraft: string;
};

type IntelligenceWorkspaceProps = {
  dayIntelligence: DayIntelligencePayload | null;
  dayIntelligenceError: string | null;
  dayIntelligenceLoading: boolean;
  onOpenBrowseWorkspace: () => void;
  onOpenReviewWorkspace: () => void;
  onSearchForTerm: (term: string) => void;
  selectedDayLabel: string;
  selectedDaySummary: DaySummary;
};

type UtilityRailProps = {
  activeRetrievalResultIndex: number;
  captureSearchQuery: string;
  intervalMinutes: number;
  isRetrievalLoading: boolean;
  isRecording: boolean;
  isJumpToNowDisabled: boolean;
  nextCaptureLabel: string;
  ocrHealth: OcrHealthPayload;
  performanceSnapshot: PerformanceSnapshotPayload;
  retrievalError: string | null;
  retrievalResults: RetrievalSearchResult[];
  onCaptureNow: () => void;
  onDeleteDay: () => void;
  onOpenBrowseWorkspace: () => void;
  onOpenIntelligenceWorkspace: () => void;
  onOpenReviewWorkspace: () => void;
  onJumpToNow: () => void;
  onSelectSearchResult: (result: RetrievalSearchResult) => void;
  onSearchQueryChange: (nextValue: string) => void;
  onTogglePause: () => void;
  searchInputRef: MutableRefObject<HTMLInputElement | null>;
  selectedDaySummary: DaySummary;
  storageStats: StorageStatsPayload;
  todayCaptureCount: number;
  workspaceMode: WorkspaceMode;
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
  draftStartupOnBoot: boolean;
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
  onDraftStartupOnBootChange: (nextValue: boolean) => void;
  onExportBackup: () => void;
  onImportBackup: () => void;
  onReindexAllCaptures: () => void;
  onOpenCapturesFolder: () => void;
  onResetDraft: () => void;
  onSaveSettings: () => void;
  settingsDirty: boolean;
  startupOnBootSupported: boolean;
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

type QuickStartModalProps = {
  intervalMinutes: number;
  onCaptureNow: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
};

type KeyboardShortcutsModalProps = {
  onClose: () => void;
  onOpenSettings: () => void;
};

type ConfirmationModalTone = "danger" | "neutral";

type ConfirmationModalProps = {
  body: ReactNode;
  confirmLabel: string;
  isConfirmDisabled?: boolean;
  title: string;
  tone?: ConfirmationModalTone;
  onClose: () => void;
  onConfirm: () => void;
};

type TimelineStripProps = {
  captures: CaptureRecord[];
  hasNewerPages: boolean;
  hasOlderPages: boolean;
  hourMarkers: string[];
  isPageLoading: boolean;
  loadedEndOffset: number;
  loadedStartOffset: number;
  onCaptureNow: () => void;
  onClearSearch: () => void;
  onLoadNewer: () => void;
  onLoadOlder: () => void;
  onOpenSettings: () => void;
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

export function TopBar({
  hasNextDay,
  hasPreviousDay,
  isWindowMaximized,
  selectedDayCaptureCount,
  selectedDayKey,
  onOpenReviewWorkspace,
  onOpenShortcuts,
  onSelectNextDay,
  onSelectPreviousDay,
  onCloseWindow,
  onMinimizeWindow,
  onToggleWindowMaximize,
}: TopBarProps) {
  const topBarDateLabel = formatTopBarDate(selectedDayKey);

  return (
    <header
      className={isWindowMaximized ? "panel topbar is-maximized" : "panel topbar"}
      data-tauri-drag-region
      onDoubleClick={onToggleWindowMaximize}
    >
      <div className="topbar-leading">
        <div className="topbar-brand">
          <img src="/memorylane_icon_logo.png" alt="MemoryLane" />
          <strong>MemoryLane</strong>
        </div>
      </div>

      <div className="topbar-focus">
        <p className="topbar-focus-label">Selected day</p>
        <div className="topbar-day-row">
          <button
            className="secondary icon-button topbar-nav"
            type="button"
            onClick={onSelectPreviousDay}
            disabled={!hasPreviousDay}
            aria-label="Previous day"
          >
            <ChevronLeft
              className="lucide-icon"
              size={ICON_SIZE}
              strokeWidth={ICON_STROKE_WIDTH}
              aria-hidden="true"
            />
          </button>

          <div className="topbar-day-summary-shell">
            <CalendarDays className="lucide-icon topbar-day-summary-icon" size={18} strokeWidth={1.9} aria-hidden="true" />
            <div className="topbar-day-summary">
              <h1>{topBarDateLabel}</h1>
              <p>{selectedDayCaptureCount} captures</p>
            </div>
            <ChevronDown className="lucide-icon topbar-day-summary-caret" size={14} strokeWidth={1.8} aria-hidden="true" />
          </div>

          <button
            className="secondary icon-button topbar-nav"
            type="button"
            onClick={onSelectNextDay}
            disabled={!hasNextDay}
            aria-label="Next day"
          >
            <ChevronRight
              className="lucide-icon"
              size={ICON_SIZE}
              strokeWidth={ICON_STROKE_WIDTH}
              aria-hidden="true"
            />
          </button>
        </div>

        <p className="topbar-subhint">
          Day: ↑/↓ or [ / ] · Capture: ←/→ or J / K · Workspace: R / I / V
        </p>
      </div>

      <div className="topbar-actions">
        <button className="topbar-review-button" type="button" onClick={onOpenReviewWorkspace}>
          Review
        </button>

        <button
          className="secondary icon-button topbar-action-button"
          type="button"
          title="Share"
          aria-label="Share"
        >
          <Share2 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
        </button>

        <button
          className="secondary icon-button topbar-action-button"
          type="button"
          title="Delete"
          aria-label="Delete capture"
        >
          <Trash2 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
        </button>

        <button
          className="secondary icon-button topbar-action-button"
          type="button"
          title="More options"
          aria-label="More options"
          onClick={onOpenShortcuts}
        >
          <MoreHorizontal className="lucide-icon" size={18} strokeWidth={1.9} aria-hidden="true" />
        </button>

        <div className={isWindowMaximized ? "window-controls-rail is-maximized" : "window-controls-rail"} role="toolbar" aria-label="Window controls">
          <button className="topbar-window-btn" type="button" title="Minimize" aria-label="Minimize window" onClick={onMinimizeWindow}>
            <Minus className="lucide-icon" size={14} strokeWidth={2} aria-hidden="true" />
          </button>
          <button
            className="topbar-window-btn"
            type="button"
            title={isWindowMaximized ? "Restore" : "Maximize"}
            aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
            onClick={onToggleWindowMaximize}
          >
            <Square className="lucide-icon" size={13} strokeWidth={2} aria-hidden="true" />
          </button>
          <button className="topbar-window-btn topbar-window-close" type="button" title="Close" aria-label="Close window" onClick={onCloseWindow}>
            <X className="lucide-icon" size={14} strokeWidth={2.2} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function DayRail({
  workspaceMode,
  recentDays,
  selectedDayKey,
  todayKey,
  onApplyStructuredFilter,
  onFocusSearch,
  onOpenBrowseWorkspace,
  onOpenIntelligenceWorkspace,
  onOpenReviewWorkspace,
  onOpenAllCapturesWorkspace,
  onOpenCalendarWorkspace,
  onSelectDay,
  onShowDayTooltip,
  onHideDayTooltip,
}: DayRailProps) {
  const visibleDays = recentDays.slice(0, 7);
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);
  const [tagFilterDraft, setTagFilterDraft] = useState("");

  const applyFilter = (query: string) => {
    onApplyStructuredFilter(query);
    setIsFilterPanelOpen(false);
  };

  return (
    <aside className="panel day-rail">
      <section className="day-rail-section">
        <p className="day-rail-section-title">Library</p>
        <div className="library-nav">
          <button
            className={workspaceMode === "browse" ? "library-nav-item active" : "library-nav-item"}
            type="button"
            onClick={onOpenBrowseWorkspace}
          >
            <Clock3 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span><strong>Timeline</strong><small>day stream</small></span>
          </button>
          <button
            className={workspaceMode === "calendar" ? "library-nav-item active" : "library-nav-item"}
            type="button"
            onClick={onOpenCalendarWorkspace}
          >
            <CalendarDays className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span><strong>Calendar</strong><small>date map</small></span>
          </button>
          <button
            className={workspaceMode === "all-captures" ? "library-nav-item active" : "library-nav-item"}
            type="button"
            onClick={onOpenAllCapturesWorkspace}
          >
            <Layers3 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span><strong>All Captures</strong><small>archive grid</small></span>
          </button>
          <button
            className={workspaceMode === "review" ? "library-nav-item active" : "library-nav-item"}
            type="button"
            onClick={onOpenReviewWorkspace}
          >
            <Tag className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span><strong>Tags</strong><small>review states</small></span>
          </button>
          <button className="library-nav-item" type="button" onClick={onFocusSearch}>
            <Search className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span><strong>Search</strong><small>focus query</small></span>
          </button>
          <button
            className={workspaceMode === "intelligence" ? "library-nav-item active" : "library-nav-item"}
            type="button"
            onClick={onOpenIntelligenceWorkspace}
          >
            <Sparkles className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span><strong>Intelligence</strong><small>day summary</small></span>
          </button>
        </div>
      </section>

      <section className="day-rail-section day-list-section">
        <p className="day-rail-section-title">Days</p>
        <div className="day-rail-list">
        {visibleDays.map((day) => {
          const isSelected = day.dayKey === selectedDayKey;
          const today = todayKey;
          const yesterday = dayKeyFromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
          
          let title = "";
          let subtitle = "";
          
          const dateObj = dayDateFromKey(day.dayKey);
          const dayOfMonth = dateObj.getDate();

          if (day.dayKey === today) {
            title = "Today";
            subtitle = formatDaySecondary(day.dayKey);
          } else if (day.dayKey === yesterday) {
            title = "Yesterday";
            subtitle = formatDaySecondary(day.dayKey);
          } else {
            title = formatViewerDate(day.dayKey);
            subtitle = `${day.captureCount} captures`;
          }

          return (
            <button
              key={day.dayKey}
              className={isSelected ? "day-rail-entry selected" : "day-rail-entry"}
              type="button"
              onClick={() => {
                onHideDayTooltip?.();
                onSelectDay(day.dayKey);
              }}
              onMouseEnter={(e) => onShowDayTooltip?.(e, day.dayKey, day.captureCount)}
              onMouseLeave={onHideDayTooltip}
            >
              <span className="day-rail-entry-main">
                <span className="day-rail-label">{title}</span>
                <span className="day-rail-meta">{subtitle}</span>
              </span>
              <span className="day-rail-count">{dayOfMonth}</span>
            </button>
          );
        })}
        </div>
        {recentDays.length > visibleDays.length ? (
          <button className="day-rail-more" type="button" onClick={onOpenCalendarWorkspace}>
            Show More Days
            <ChevronDown className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </button>
        ) : null}
      </section>

      <div className="day-rail-filter-wrap">
        <button
          className={isFilterPanelOpen ? "day-rail-filter active" : "day-rail-filter"}
          type="button"
          onClick={() => setIsFilterPanelOpen((current) => !current)}
          aria-expanded={isFilterPanelOpen}
        >
          <Filter className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          <span>Filters</span>
        </button>

        {isFilterPanelOpen ? (
          <div className="structured-filter-panel" role="dialog" aria-label="Structured capture filters">
            <p className="structured-filter-title">Structured filters</p>
            <div className="structured-filter-grid">
              <button type="button" onClick={() => applyFilter("bookmarked")}>Bookmarked</button>
              <button type="button" onClick={() => applyFilter("favorite")}>Favorites</button>
              <button type="button" onClick={() => applyFilter("bookmarked favorite")}>Saved + Favorite</button>
              <button type="button" onClick={() => applyFilter(todayKey)}>Today</button>
              <button type="button" onClick={() => applyFilter("yesterday")}>Yesterday</button>
              <button type="button" onClick={() => applyFilter(selectedDayKey)}>Selected day</button>
              <button type="button" onClick={() => applyFilter("ocr")}>Has OCR text</button>
              <button type="button" onClick={() => applyFilter("redact")}>Redaction context</button>
            </div>
            <label className="structured-tag-filter">
              <span>Tag</span>
              <input
                value={tagFilterDraft}
                placeholder="roadmap"
                onChange={(event) => setTagFilterDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && tagFilterDraft.trim()) {
                    applyFilter(`tag:${tagFilterDraft.trim().replace(/^#/, "")}`);
                  }
                }}
              />
            </label>
            <div className="structured-filter-actions">
              <button
                className="secondary compact"
                type="button"
                onClick={() => applyFilter(`tag:${tagFilterDraft.trim().replace(/^#/, "")}`)}
                disabled={!tagFilterDraft.trim()}
              >
                apply tag
              </button>
              <button className="secondary compact" type="button" onClick={() => setIsFilterPanelOpen(false)}>
                close
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

export function ViewerPane({
  actionMessage,
  captureHealth,
  captures,
  compareCaptureLabel,
  compareImageDataUrl,
  contextBadge,
  isFilterActive,
  onCaptureNow,
  onClearSearch,
  onCopyPath,
  onClearCompareAnchor,
  onDeleteCapture,
  onOpenSettings,
  onOpenCapturesFolder,
  onRedactCapture,
  onSetCompareAnchor,
  onSelectNext,
  onSelectPrevious,
  onSelectFirst,
  onSelectLast,
  onToggleFullscreen,
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
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);

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
              <ChevronLeft
                className="viewer-step-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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
              <ChevronRight
                className="viewer-step-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
            </button>

            <div className="capture-toolbar" role="toolbar" aria-label="Capture actions">
              <div className="capture-toolbar-group capture-toolbar-leading">
                <button
                  className="viewer-tool-button"
                  type="button"
                  title="Open captures folder"
                  aria-label="Open captures folder"
                  onClick={onOpenCapturesFolder}
                >
                  <Share2 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button
                  className={selectedCapture?.isBookmarked ? "viewer-tool-button active" : "viewer-tool-button"}
                  type="button"
                  title={selectedCapture?.isBookmarked ? "Remove bookmark" : "Bookmark capture"}
                  aria-label={selectedCapture?.isBookmarked ? "Remove bookmark" : "Bookmark capture"}
                  onClick={onToggleBookmark}
                >
                  <Bookmark className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button
                  className={selectedCapture?.isFavorite ? "viewer-tool-button active" : "viewer-tool-button"}
                  type="button"
                  title={selectedCapture?.isFavorite ? "Remove favorite" : "Favorite capture"}
                  aria-label={selectedCapture?.isFavorite ? "Remove favorite" : "Favorite capture"}
                  onClick={onToggleFavorite}
                >
                  <Star className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
              </div>

              <div className="capture-toolbar-group capture-toolbar-center">
                <button
                  className="viewer-tool-button"
                  type="button"
                  onClick={onSelectFirst}
                  disabled={selectedCaptureIndex <= 0}
                  title="Jump to first capture"
                  aria-label="Jump to first capture in view"
                >
                  <ChevronLeft className="lucide-icon" size={22} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button
                  className="viewer-tool-button"
                  type="button"
                  onClick={onSelectLast}
                  disabled={selectedCaptureIndex >= captures.length - 1}
                  title="Jump to last capture"
                  aria-label="Jump to last capture in view"
                >
                  <ChevronRight className="lucide-icon" size={22} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
              </div>

              <div className="capture-toolbar-group capture-toolbar-trailing">
                <span className="viewer-caption" title={contextBadge}>
                  {selectedCapture?.timestampLabel ?? "Selected"}
                  {selectedCapture ? ` · ${contextBadge}` : ""}
                </span>
                <button
                  className="viewer-tool-button"
                  type="button"
                  title={selectedCapture ? `${selectedCapture.width} × ${selectedCapture.height}` : "Capture info"}
                  aria-label="Capture info"
                  onClick={() => setIsDetailsOpen((current) => !current)}
                  aria-expanded={isDetailsOpen}
                >
                  <Info className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button className="viewer-tool-button" type="button" title="Copy path" aria-label="Copy path" onClick={onCopyPath}>
                  <Copy className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button
                  className={hasCompareAnchor ? "viewer-tool-button active" : "viewer-tool-button"}
                  type="button"
                  title={hasCompareAnchor ? "Clear compare" : "Set compare anchor"}
                  aria-label={hasCompareAnchor ? "Clear compare" : "Set compare anchor"}
                  onClick={hasCompareAnchor ? onClearCompareAnchor : onSetCompareAnchor}
                >
                  <Layers3 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button className="viewer-tool-button" type="button" title="Redact capture" aria-label="Redact capture" onClick={onRedactCapture}>
                  <Shield className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button className="viewer-tool-button danger" type="button" title="Delete capture" aria-label="Delete capture" onClick={onDeleteCapture}>
                  <Trash2 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
                <button
                  className="viewer-tool-button"
                  type="button"
                  title="Toggle fullscreen"
                  aria-label="Toggle fullscreen"
                  onClick={onToggleFullscreen}
                >
                  <Maximize2 className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                </button>
              </div>
            </div>

            {isDetailsOpen && selectedCapture ? (
              <div className="capture-details-popover" role="dialog" aria-label="Capture details">
                <div className="capture-details-head">
                  <div>
                    <p className="section-title">Capture details</p>
                    <h3>{selectedCapture.timestampLabel}</h3>
                  </div>
                  <button className="secondary compact" type="button" onClick={() => setIsDetailsOpen(false)}>
                    close
                  </button>
                </div>
                <dl className="capture-details-list">
                  <div><dt>Captured</dt><dd>{formatViewerDate(selectedCapture.dayKey)} · {formatCaptureTimestamp(selectedCapture.capturedAt)}</dd></div>
                  <div><dt>Dimensions</dt><dd>{selectedCapture.width} × {selectedCapture.height}</dd></div>
                  <div><dt>App</dt><dd>{selectedCapture.processName || "Unknown app"}</dd></div>
                  <div><dt>Window</dt><dd>{selectedCapture.windowTitle || "Window metadata unavailable"}</dd></div>
                  <div><dt>File path</dt><dd>{selectedCapture.imagePath}</dd></div>
                  <div>
                    <dt>Review state</dt>
                    <dd>{[
                      selectedCapture.isBookmarked ? "bookmarked" : "",
                      selectedCapture.isFavorite ? "favorite" : "",
                      selectedCapture.tags.length > 0 ? `${selectedCapture.tags.length} tag(s)` : "",
                    ].filter(Boolean).join(", ") || "unmarked"}</dd>
                  </div>
                  <div><dt>Context</dt><dd>{contextBadge}</dd></div>
                </dl>
              </div>
            ) : null}
          </div>
        </section>
      ) : (
        <section className="empty-state">
          <p className="section-title">No captures in view</p>
          <h3>{isFilterActive ? "No capture matched this search" : "Your timeline starts in the tray"}</h3>
          <p>
            {isFilterActive
              ? "Try a broader phrase, remove a filter token, or jump to another day."
              : "MemoryLane captures quietly in the background. Installed builds keep running from the tray even after closing the window."}
          </p>
          <div className="empty-actions">
            {isFilterActive ? (
              <button className="secondary" type="button" onClick={onClearSearch}>
                clear search
              </button>
            ) : (
              <>
                <button className="secondary" type="button" onClick={onCaptureNow}>
                  capture now
                </button>
                <button className="secondary" type="button" onClick={onOpenSettings}>
                  review capture settings
                </button>
              </>
            )}
            <button className="secondary" type="button" onClick={onOpenCapturesFolder}>
              open captures folder
            </button>
          </div>
          <p className="empty-help">Tip: press <strong>?</strong> for keyboard shortcuts.</p>
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

export function ReviewWorkspace({
  compareCaptureLabel,
  isReviewBusy,
  noteDirty,
  noteDraft,
  noteSaveState,
  onApplyTagFilter,
  onClearCompareAnchor,
  onJumpToReviewCapture,
  onNoteDraftChange,
  onOpenBrowseWorkspace,
  onOpenIntelligenceWorkspace,
  onRedactCapture,
  onSaveNote,
  onSaveTags,
  onSetCompareAnchor,
  onTagDraftChange,
  onToggleBookmark,
  onToggleFavorite,
  reviewShortcuts,
  selectedCapture,
  selectedDayLabel,
  tagDraft,
}: ReviewWorkspaceProps) {
  const bookmarkedShortcuts = reviewShortcuts.bookmarks.slice(0, 10);
  const favoriteShortcuts = reviewShortcuts.favorites.slice(0, 10);
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
  const noteStatusText = noteStatusLabel || "Up to date";
  const selectedCaptureSummary = selectedCapture
    ? `${selectedCapture.timestampLabel} · ${selectedCapture.processName || "Unknown app"}`
    : `No capture selected for ${selectedDayLabel}.`;
  const selectedWindowLabel = selectedCapture?.windowTitle?.trim().length
    ? selectedCapture.windowTitle
    : null;

  return (
    <main className="panel viewer-pane workspace-pane review-workspace">
      <div className="workspace-head">
        <div>
          <p className="section-title">Workspace</p>
          <h2>Review tools</h2>
          <p className="workspace-lead">Mark, compare, and jump through important moments for {selectedDayLabel}.</p>
        </div>
        <div className="workspace-head-actions">
          <button className="secondary compact" type="button" onClick={onOpenBrowseWorkspace}>
            browse workspace
          </button>
          <button className="secondary compact" type="button" onClick={onOpenIntelligenceWorkspace}>
            day intelligence
          </button>
        </div>
      </div>

      <div className="workspace-scroll">
        <div className="review-layout-grid">
          <section className="workspace-card workspace-card-hero review-capture-card">
            <div className="section-row">
              <h3>Current capture</h3>
              <span className="note-status">{noteStatusText}</span>
            </div>

            <p className="workspace-meta-line">{selectedCaptureSummary}</p>
            {selectedWindowLabel ? <p className="workspace-meta-line workspace-meta-line-secondary">{selectedWindowLabel}</p> : null}

            <div className="retrieval-result-badges review-state-badges">
              {selectedCapture?.isBookmarked ? <span className="source-pill">bookmarked</span> : null}
              {selectedCapture?.isFavorite ? <span className="source-pill">favorite</span> : null}
              <span className="source-pill">{compareCaptureLabel ? "compare ready" : "compare empty"}</span>
            </div>

            <div className="review-action-row">
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

            <label className="field-block review-note-field" htmlFor="review-note-input">
              <span>Capture note</span>
              <textarea
                id="review-note-input"
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
            </label>
            <div className="review-inline-actions">
              <button className="secondary compact" type="button" onClick={onSaveNote} disabled={!selectedCapture || !noteDirty}>
                save note
              </button>
            </div>
          </section>

          <section className="workspace-card review-tag-card">
            <h3>Tags and filters</h3>
            <label className="field-block" htmlFor="review-capture-tags-input">
              <span>Capture tags</span>
              <input
                id="review-capture-tags-input"
                type="text"
                value={tagDraft}
                placeholder="roadmap, launch, meeting"
                disabled={!selectedCapture}
                onChange={(event) => onTagDraftChange(event.currentTarget.value)}
              />
            </label>
            <div className="review-inline-actions">
              <button className="secondary compact" type="button" onClick={onSaveTags} disabled={!selectedCapture || isReviewBusy}>
                save tags
              </button>
            </div>

            {selectedCapture?.tags.length ? (
              <div className="review-shortcuts-grid">
                <p className="workspace-subtitle">On this capture</p>
                <div className="retrieval-result-badges">
                  {selectedCapture.tags.map((tag) => (
                    <button
                      key={`${selectedCapture.id}-selected-tag-${tag}`}
                      className="source-pill source-pill-button"
                      type="button"
                      onClick={() => {
                        onApplyTagFilter(tag);
                        onOpenBrowseWorkspace();
                      }}
                    >
                      #{tag}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <p className="storage-meta">No tags on the current capture yet.</p>
            )}

            {reviewShortcuts.tags.length > 0 ? (
              <div className="review-shortcuts-grid">
                <p className="workspace-subtitle">Top tags across saved moments</p>
                <div className="retrieval-result-badges">
                  {reviewShortcuts.tags.slice(0, 12).map((tag) => (
                    <button
                      key={`tag-shortcut-${tag.tag}`}
                      className="source-pill source-pill-button"
                      type="button"
                      onClick={() => {
                        onApplyTagFilter(tag.tag);
                        onOpenBrowseWorkspace();
                      }}
                    >
                      #{tag.tag} ({tag.captureCount})
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="workspace-card review-library-card">
            <h3>Saved moments</h3>

            <div className="review-library-grid">
              <div className="review-library-column">
                <p className="workspace-subtitle">Bookmarks</p>
                {bookmarkedShortcuts.length === 0 ? (
                  <p className="storage-meta">No bookmarks yet.</p>
                ) : (
                  <div className="review-shortcuts-grid">
                    {bookmarkedShortcuts.map((shortcut) => (
                      <button
                        key={`bookmark-${shortcut.captureId}`}
                        className="secondary compact review-jump"
                        type="button"
                        onClick={() => {
                          onJumpToReviewCapture(shortcut.captureId);
                          onOpenBrowseWorkspace();
                        }}
                      >
                        {formatViewerDate(shortcut.dayKey)} · {shortcut.timestampLabel}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="review-library-column">
                <p className="workspace-subtitle">Favorites</p>
                {favoriteShortcuts.length === 0 ? (
                  <p className="storage-meta">No favorites yet.</p>
                ) : (
                  <div className="review-shortcuts-grid">
                    {favoriteShortcuts.map((shortcut) => (
                      <button
                        key={`favorite-${shortcut.captureId}`}
                        className="secondary compact review-jump"
                        type="button"
                        onClick={() => {
                          onJumpToReviewCapture(shortcut.captureId);
                          onOpenBrowseWorkspace();
                        }}
                      >
                        {formatViewerDate(shortcut.dayKey)} · {shortcut.timestampLabel}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

export function IntelligenceWorkspace({
  dayIntelligence,
  dayIntelligenceError,
  dayIntelligenceLoading,
  onOpenBrowseWorkspace,
  onOpenReviewWorkspace,
  onSearchForTerm,
  selectedDayLabel,
  selectedDaySummary,
}: IntelligenceWorkspaceProps) {
  const topThemes = dayIntelligence?.topTerms ?? [];
  const focusBlocks = dayIntelligence?.focusBlocks ?? [];
  const changeHighlights = dayIntelligence?.changeHighlights ?? [];
  const focusPreview = dayIntelligence?.focusBlocks.slice(0, 8) ?? [];
  const focusOverflow = dayIntelligence?.focusBlocks.slice(8) ?? [];
  const highlightsPreview = dayIntelligence?.changeHighlights.slice(0, 10) ?? [];
  const highlightsOverflow = dayIntelligence?.changeHighlights.slice(10) ?? [];

  return (
    <main className="panel viewer-pane workspace-pane intelligence-workspace">
      <div className="workspace-head">
        <div>
          <p className="section-title">Workspace</p>
          <h2>Day intelligence</h2>
          <p className="workspace-lead">Session-level context and day shifts for {selectedDayLabel}.</p>
        </div>
        <div className="workspace-head-actions">
          <button className="secondary compact" type="button" onClick={onOpenBrowseWorkspace}>
            browse workspace
          </button>
          <button className="secondary compact" type="button" onClick={onOpenReviewWorkspace}>
            review workspace
          </button>
        </div>
      </div>

      <div className="workspace-scroll">
        <section className="workspace-card workspace-card-hero intelligence-section intelligence-overview-card">
          <div className="section-row intelligence-head">
            <h3>Day overview</h3>
            <span className="source-pill">{selectedDaySummary.captureCount} captures</span>
          </div>

          {dayIntelligenceLoading ? <p className="storage-meta">Summarizing this day...</p> : null}
          {dayIntelligenceError ? <p className="storage-meta warning">{dayIntelligenceError}</p> : null}

          {!dayIntelligenceLoading && !dayIntelligenceError && dayIntelligence ? (
            <>
              <p className="storage-meta intelligence-summary">{dayIntelligence.summary}</p>
              <div className="intelligence-metric-grid">
                <article className="intelligence-metric">
                  <span>sessions</span>
                  <strong>{focusBlocks.length}</strong>
                </article>
                <article className="intelligence-metric">
                  <span>change notes</span>
                  <strong>{changeHighlights.length}</strong>
                </article>
                <article className="intelligence-metric">
                  <span>theme signals</span>
                  <strong>{topThemes.length}</strong>
                </article>
              </div>

              <p className="storage-meta">
                Generated in {dayIntelligence.generationMs}ms at {dayIntelligence.generatedAt}
              </p>

              {topThemes.length > 0 ? (
                <>
                  <p className="workspace-subtitle">Top themes</p>
                  <div className="retrieval-result-badges intelligence-themes">
                    {topThemes.map((term) => (
                      <button
                        key={`intelligence-term-${term}`}
                        className="source-pill source-pill-button"
                        type="button"
                        onClick={() => onSearchForTerm(term)}
                      >
                        {term}
                      </button>
                    ))}
                  </div>
                  <p className="storage-meta">Pick a theme to return to Browse with a filtered query.</p>
                </>
              ) : null}
            </>
          ) : null}

          {!dayIntelligenceLoading && !dayIntelligenceError && !dayIntelligence ? (
            <p className="storage-meta">No intelligence summary available for this day yet.</p>
          ) : null}
        </section>

        {!dayIntelligenceLoading && !dayIntelligenceError && dayIntelligence ? (
          <>
            <section className="workspace-card intelligence-section intelligence-session-card">
              <div className="section-row intelligence-head">
                <h3>Focus sessions</h3>
                <span className="source-pill intelligence-session-pill">
                  {dayIntelligence.focusBlocks.length} session{dayIntelligence.focusBlocks.length === 1 ? "" : "s"}
                </span>
              </div>

              {focusPreview.length > 0 ? (
                <div className="intelligence-blocks intelligence-blocks-workspace">
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
              ) : (
                <p className="storage-meta">No sessions yet. Capture activity will appear here automatically.</p>
              )}

              {focusOverflow.length > 0 ? (
                <details className="intelligence-fold">
                  <summary>Show {focusOverflow.length} more session{focusOverflow.length === 1 ? "" : "s"}</summary>
                  <div className="intelligence-blocks intelligence-blocks-overflow intelligence-blocks-workspace">
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
            </section>

            <section className="workspace-card intelligence-section intelligence-change-card">
              <h3>What changed today</h3>
              {highlightsPreview.length > 0 ? (
                <ul className="intelligence-highlights">
                  {highlightsPreview.map((highlight, index) => (
                    <li key={`highlight-preview-${index}-${highlight}`}>{highlight}</li>
                  ))}
                </ul>
              ) : (
                <p className="storage-meta">No major context shifts detected for this day.</p>
              )}

              {highlightsOverflow.length > 0 ? (
                <details className="intelligence-fold">
                  <summary>
                    Show {highlightsOverflow.length} more change note{highlightsOverflow.length === 1 ? "" : "s"}
                  </summary>
                  <ul className="intelligence-highlights intelligence-highlights-overflow">
                    {highlightsOverflow.map((highlight, index) => (
                      <li key={`highlight-overflow-${index}-${highlight}`}>{highlight}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

type AllCapturesWorkspaceProps = {
  onOpenBrowseWorkspace: () => void;
  onOpenReviewWorkspace: () => void;
  onOpenIntelligenceWorkspace: () => void;
  onSelectCapture: (captureId: number) => void;
};

export function AllCapturesWorkspace({
  onOpenBrowseWorkspace,
  onOpenReviewWorkspace,
  onOpenIntelligenceWorkspace,
  onSelectCapture,
}: AllCapturesWorkspaceProps) {
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [offset, setOffset] = useState<number>(0);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const PAGE_SIZE = 60;

  const loadMore = useCallback(async (currentOffset: number, append: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const page = await invoke<CaptureRecord[]>("get_all_captures_page", {
        offset: currentOffset,
        limit: PAGE_SIZE,
      });

      if (append) {
        setCaptures((prev) => {
          const existingIds = new Set(prev.map((c) => c.id));
          const filteredPage = page.filter((c) => !existingIds.has(c.id));
          return [...prev, ...filteredPage];
        });
      } else {
        setCaptures(page);
      }

      setOffset(currentOffset + page.length);
    } catch (err: any) {
      console.error(err);
      setError(err?.toString() || "Failed to load captures.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const refreshCount = useCallback(async () => {
    try {
      const count = await invoke<number>("get_total_capture_count");
      setTotalCount(count);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    refreshCount();
    loadMore(0, false);
  }, [refreshCount, loadMore]);

  return (
    <main className="panel viewer-pane workspace-pane all-captures-workspace">
      <div className="workspace-head">
        <div>
          <p className="section-title">Workspace</p>
          <h2>All Captures Gallery</h2>
          <p className="workspace-lead">Browse and skim through the entire history of recorded screenshots.</p>
        </div>
        <div className="workspace-head-actions">
          <button className="secondary compact" type="button" onClick={onOpenBrowseWorkspace}>
            timeline
          </button>
          <button className="secondary compact" type="button" onClick={onOpenReviewWorkspace}>
            tags
          </button>
          <button className="secondary compact" type="button" onClick={onOpenIntelligenceWorkspace}>
            intelligence
          </button>
        </div>
      </div>

      <div className="workspace-scroll">
        <section className="workspace-card workspace-card-hero">
          <div className="section-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3>Historical Gallery</h3>
            <span className="source-pill" style={{ fontStyle: "normal" }}>{totalCount} total captures</span>
          </div>
          {error ? <p className="storage-meta warning">{error}</p> : null}

          <div className="all-captures-grid">
            {captures.map((capture) => (
              <div
                key={capture.id}
                className="all-captures-card"
                onClick={() => onSelectCapture(capture.id)}
              >
                <div className="all-captures-card-img-wrapper">
                  <img
                    className="all-captures-card-img"
                    src={capture.thumbnailDataUrl}
                    alt={capture.windowTitle || "Capture preview"}
                    loading="lazy"
                  />
                </div>
                <div className="all-captures-card-info">
                  <span className="all-captures-card-meta">
                    {new Intl.DateTimeFormat("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    }).format(new Date(capture.capturedAt))}
                  </span>
                  <h4 className="all-captures-card-title" title={capture.windowTitle}>
                    {capture.windowTitle || "Untitled Window"}
                  </h4>
                  <span className="all-captures-card-app">
                    {capture.processName || "Unknown Application"}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {isLoading ? (
            <p className="storage-meta" style={{ textAlign: "center", padding: "12px 0" }}>Loading previews...</p>
          ) : captures.length < totalCount ? (
            <button
              className="all-captures-load-more"
              type="button"
              onClick={() => loadMore(offset, true)}
            >
              Load More (showing {captures.length} of {totalCount})
            </button>
          ) : (
            captures.length > 0 && (
              <p className="storage-meta" style={{ textAlign: "center", padding: "12px 0", color: "var(--text-soft)" }}>
                Showing all captures.
              </p>
            )
          )}
        </section>
      </div>
    </main>
  );
}

type CalendarWorkspaceProps = {
  daySummaries: DaySummary[];
  onOpenBrowseWorkspace: () => void;
  onOpenReviewWorkspace: () => void;
  onOpenIntelligenceWorkspace: () => void;
  onSelectDay: (dayKey: string) => void;
};

export function CalendarWorkspace({
  daySummaries,
  onOpenBrowseWorkspace,
  onOpenReviewWorkspace,
  onOpenIntelligenceWorkspace,
  onSelectDay,
}: CalendarWorkspaceProps) {
  const [viewDate, setViewDate] = useState<Date>(() => new Date());

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const handlePrevMonth = () => {
    setViewDate(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setViewDate(new Date(year, month + 1, 1));
  };

  const totalDays = new Date(year, month + 1, 0).getDate();
  const firstDayOffset = new Date(year, month, 1).getDay();

  const summariesMap = useMemo(() => {
    const map = new Map<string, DaySummary>();
    for (const summary of daySummaries) {
      map.set(summary.dayKey, summary);
    }
    return map;
  }, [daySummaries]);

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const cells = [];
  for (let i = 0; i < firstDayOffset; i++) {
    cells.push({ key: `empty-${i}`, isEmpty: true });
  }

  const todayStr = dayKeyFromDate(new Date());

  for (let dayNum = 1; dayNum <= totalDays; dayNum++) {
    const cellDate = new Date(year, month, dayNum);
    const dayKey = dayKeyFromDate(cellDate);
    const summary = summariesMap.get(dayKey);
    const isToday = dayKey === todayStr;

    cells.push({
      key: dayKey,
      isEmpty: false,
      dayNum,
      dayKey,
      isToday,
      captureCount: summary?.captureCount || 0,
      hasCaptures: (summary?.captureCount || 0) > 0,
    });
  }

  const monthLabel = viewDate.toLocaleString("default", { month: "long" });

  return (
    <main className="panel viewer-pane workspace-pane calendar-workspace">
      <div className="workspace-head">
        <div>
          <p className="section-title">Workspace</p>
          <h2>Calendar Navigator</h2>
          <p className="workspace-lead">Select and navigate directly to any historical day containing recorded captures.</p>
        </div>
        <div className="workspace-head-actions">
          <button className="secondary compact" type="button" onClick={onOpenBrowseWorkspace}>
            timeline
          </button>
          <button className="secondary compact" type="button" onClick={onOpenReviewWorkspace}>
            tags
          </button>
          <button className="secondary compact" type="button" onClick={onOpenIntelligenceWorkspace}>
            intelligence
          </button>
        </div>
      </div>

      <div className="workspace-scroll">
        <section className="workspace-card workspace-card-hero">
          <div className="calendar-workspace-container">
            <div className="calendar-header">
              <button className="calendar-nav-btn" type="button" onClick={handlePrevMonth}>
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              <h3>{monthLabel} {year}</h3>
              <button className="calendar-nav-btn" type="button" onClick={handleNextMonth}>
                <ChevronRight size={16} strokeWidth={2} />
              </button>
            </div>

            <div className="calendar-grid">
              {weekdays.map((wd) => (
                <div key={wd} className="calendar-weekday">{wd}</div>
              ))}

              {cells.map((cell) => {
                if (cell.isEmpty) {
                  return <div key={cell.key} className="calendar-day-cell empty-cell" />;
                }

                const className = [
                  "calendar-day-cell",
                  cell.hasCaptures ? "has-captures" : "",
                  cell.isToday ? "today" : "",
                ].join(" ").trim();

                return (
                  <button
                    key={cell.key}
                    type="button"
                    className={className}
                    onClick={() => {
                      if (cell.hasCaptures) {
                        onSelectDay(cell.dayKey);
                      }
                    }}
                    disabled={!cell.hasCaptures}
                    title={cell.hasCaptures ? `${cell.captureCount} captures recorded` : "No captures"}
                  >
                    <span className="calendar-day-num">{cell.dayNum}</span>
                    {cell.hasCaptures ? (
                      <span className="calendar-day-captures-count">
                        {cell.captureCount}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export function UtilityRail({
  activeRetrievalResultIndex,
  captureSearchQuery,
  intervalMinutes,
  isRetrievalLoading,
  isRecording,
  nextCaptureLabel,
  ocrHealth,
  performanceSnapshot,
  retrievalError,
  retrievalResults,
  onCaptureNow,
  onDeleteDay,
  onOpenBrowseWorkspace,
  onOpenReviewWorkspace,
  onSelectSearchResult,
  onSearchQueryChange,
  onTogglePause,
  searchInputRef,
  selectedDaySummary,
  storageStats,
  todayCaptureCount,
  workspaceMode,
}: UtilityRailProps) {
  const isBrowseWorkspace = workspaceMode === "browse";
  const isReviewWorkspace = workspaceMode === "review";
  const [isIntelligenceInfoOpen, setIsIntelligenceInfoOpen] = useState(false);

  return (
    <aside className="panel utility-rail">
      <section className="utility-section workspace-switcher-section">
        <h3>Workspace</h3>

        <div className="workspace-switch-grid">
          <button
            className={isReviewWorkspace ? "workspace-switch-button active" : "workspace-switch-button"}
            type="button"
            onClick={onOpenReviewWorkspace}
            disabled={isReviewWorkspace}
          >
            Review
          </button>
          <button
            className={isBrowseWorkspace ? "workspace-switch-button active" : "workspace-switch-button"}
            type="button"
            onClick={onOpenBrowseWorkspace}
            disabled={isBrowseWorkspace}
          >
            Browse
          </button>
        </div>
      </section>

      <section className="utility-section intelligence-mode-section">
        <div className="section-row">
          <h3>Intelligence</h3>
          <button
            className={isIntelligenceInfoOpen ? "utility-inline-chip active" : "utility-inline-chip"}
            type="button"
            onClick={() => setIsIntelligenceInfoOpen((current) => !current)}
            aria-expanded={isIntelligenceInfoOpen}
          >
            <span>On-device status</span>
            <ChevronDown className="lucide-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
          </button>
        </div>
        <p className="storage-meta utility-breadcrumb">Private local processing ? search {performanceSnapshot.lastSearchMs}ms</p>
        {isIntelligenceInfoOpen ? (
          <div className="utility-info-card">
            <strong>Local intelligence</strong>
            <span>Search, OCR health, and day summaries run against your local archive. Use the left rail Intelligence workspace for the full day summary.</span>
          </div>
        ) : null}
      </section>

      <section className="utility-section">
            <h3>Today</h3>
            <div className="today-stat-grid">
              <div>
                <strong>{todayCaptureCount}</strong>
                <span>Capture</span>
              </div>
              <div>
                <strong>{intervalMinutes}m</strong>
                <span>Evidence</span>
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
                placeholder="Search notes, OCR, apps..."
                onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
              />
            </div>
            {!ocrHealth.engineAvailable ? <p className="storage-meta warning">{ocrHealth.statusMessage}</p> : null}
            {captureSearchQuery.trim().length === 0 ? (
              <>
                <p className="storage-meta">Press `/` to search. Query starters below prefill useful filters.</p>
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
                <p className="storage-meta">
                  Local search across notes, OCR text, app metadata, time hints, and filters like app:, window:, tag:,
                  bookmarked, favorite.
                </p>
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
                                : [
                                    <span key={`${result.captureId}-match`} className="source-pill">
                                      match
                                    </span>,
                                  ]}
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
                    <>
                      <p className="storage-meta">No matches yet. Try broader terms or a time hint like "around 2 PM".</p>
                      <div className="empty-inline-actions">
                        <button className="secondary compact" type="button" onClick={() => onSearchQueryChange("")}>
                          clear query
                        </button>
                        <button
                          className="secondary compact"
                          type="button"
                          onClick={() => onSearchQueryChange("around 3 PM yesterday")}
                        >
                          try a time hint
                        </button>
                      </div>
                    </>
                  )
                ) : null}
              </>
            ) : null}
      </section>

      <section className="utility-section">
        <h3>Recording</h3>
        <div className="recording-row">
          <span>{isRecording ? "Active" : "Paused"} · {intervalMinutes} min cadence</span>
          <button className="secondary compact" type="button" onClick={onTogglePause}>
            {isRecording ? "Pause" : "Resume"}
          </button>
        </div>
        <p className="storage-meta">{isRecording ? nextCaptureLabel : "Capture paused"}</p>
        <button className="secondary compact utility-primary-button" type="button" onClick={onCaptureNow}>
          Capture Now
        </button>
      </section>

      <section className="utility-section utility-section-muted">
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

      <section className="utility-section utility-section-muted utility-danger-section">
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

export function SettingsModal({
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
  draftStartupOnBoot,
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
  onDraftStartupOnBootChange,
  onExportBackup,
  onImportBackup,
  onReindexAllCaptures,
  onOpenCapturesFolder,
  onResetDraft,
  onSaveSettings,
  settingsDirty,
  startupOnBootSupported,
  themeId,
  themeOptions,
  storagePath,
  storageStats,
}: SettingsModalProps) {
  const appearanceSectionRef = useRef<HTMLElement | null>(null);
  const privacySectionRef = useRef<HTMLElement | null>(null);
  const cadenceSectionRef = useRef<HTMLElement | null>(null);
  const startupSectionRef = useRef<HTMLElement | null>(null);
  const storageSectionRef = useRef<HTMLElement | null>(null);
  const backupSectionRef = useRef<HTMLElement | null>(null);

  const scrollToSettingsSection = (sectionRef: MutableRefObject<HTMLElement | null>) => {
    sectionRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

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

        <nav className="settings-quick-nav" aria-label="Settings sections">
          <button className="secondary compact" type="button" onClick={() => scrollToSettingsSection(appearanceSectionRef)}>
            appearance
          </button>
          <button className="secondary compact" type="button" onClick={() => scrollToSettingsSection(privacySectionRef)}>
            privacy
          </button>
          <button className="secondary compact" type="button" onClick={() => scrollToSettingsSection(cadenceSectionRef)}>
            cadence
          </button>
          <button className="secondary compact" type="button" onClick={() => scrollToSettingsSection(startupSectionRef)}>
            startup
          </button>
          <button className="secondary compact" type="button" onClick={() => scrollToSettingsSection(storageSectionRef)}>
            storage
          </button>
          <button className="secondary compact" type="button" onClick={() => scrollToSettingsSection(backupSectionRef)}>
            backup
          </button>
        </nav>

        <p className="settings-keyboard-hint">Press Esc to close settings. Press ? any time for the keyboard guide.</p>

        <section className="settings-section" ref={appearanceSectionRef}>
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <Palette
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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

        <section className="settings-section" ref={privacySectionRef}>
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <Shield
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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

        <section className="settings-section" ref={cadenceSectionRef}>
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <Clock3
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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

        <section className="settings-section" ref={startupSectionRef}>
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <Power
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
              Startup
            </h4>
            <span className="section-meta">
              {startupOnBootSupported ? (draftStartupOnBoot ? "Enabled" : "Disabled") : "Unavailable"}
            </span>
          </div>
          <label className="startup-toggle-row" htmlFor="startup-on-boot">
            <input
              id="startup-on-boot"
              type="checkbox"
              checked={draftStartupOnBoot}
              disabled={!startupOnBootSupported}
              onChange={(event) => onDraftStartupOnBootChange(event.currentTarget.checked)}
            />
            <span className="startup-toggle-copy">
              <strong>Launch MemoryLane when Windows starts</strong>
              <span>Automatically open the app in the background after sign-in.</span>
            </span>
          </label>
          <p className="field-help">
            {startupOnBootSupported
              ? "This keeps capture running without needing to open the app manually."
              : "Startup on boot is not available in this build."}
          </p>
        </section>

        <section className="settings-section" ref={storageSectionRef}>
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <Database
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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
              <HardDrive
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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

        <section className="settings-section" ref={backupSectionRef}>
          <div className="settings-section-head">
            <h4 className="settings-section-title">
              <ShieldCheck
                className="settings-section-icon lucide-icon"
                size={ICON_SIZE}
                strokeWidth={ICON_STROKE_WIDTH}
                aria-hidden="true"
              />
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

export function ThemeOnboardingModal({
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

export function QuickStartModal({
  intervalMinutes,
  onCaptureNow,
  onClose,
  onOpenSettings,
  onOpenShortcuts,
}: QuickStartModalProps) {
  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        className="panel settings-modal quickstart-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quickstart-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-head">
          <div>
            <p className="section-title">Welcome to MemoryLane</p>
            <h3 id="quickstart-title">Quick start guide</h3>
            <p className="section-meta">Set once, then capture quietly in the background.</p>
          </div>
        </div>

        <div className="quickstart-grid">
          <article className="quickstart-card">
            <h4>Tray behavior</h4>
            <p>
              Installed builds keep MemoryLane in the system tray after closing the window, so capture can continue.
            </p>
          </article>

          <article className="quickstart-card">
            <h4>Capture cadence</h4>
            <p>
              Current cadence is every {intervalMinutes} minute{intervalMinutes === 1 ? "" : "s"}. Use <strong>Space</strong> to pause or <strong>C</strong> to capture now.
            </p>
          </article>

          <article className="quickstart-card">
            <h4>Keyboard-first flow</h4>
            <p>
              Press <strong>/</strong> to search, <strong>?</strong> for shortcuts, <strong>R</strong>/<strong>I</strong>/<strong>V</strong> to switch workspaces, <strong>↑/↓</strong> to change day, and <strong>←/→</strong> to step captures.
            </p>
          </article>
        </div>

        <div className="quickstart-actions">
          <button className="secondary" type="button" onClick={onOpenSettings}>
            open settings
          </button>
          <button className="secondary" type="button" onClick={onCaptureNow}>
            capture now
          </button>
          <button className="secondary" type="button" onClick={onOpenShortcuts}>
            view shortcuts
          </button>
          <button className="secondary" type="button" onClick={onClose}>
            continue
          </button>
        </div>
      </section>
    </div>
  );
}

export function KeyboardShortcutsModal({ onClose, onOpenSettings }: KeyboardShortcutsModalProps) {
  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        className="panel settings-modal shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-head">
          <div>
            <p className="section-title">Keyboard Guide</p>
            <h3 id="shortcuts-title">Shortcuts</h3>
            <p className="section-meta">Press Esc to close this guide.</p>
          </div>
        </div>

        <div className="shortcut-groups">
          <section className="shortcut-group" aria-label="Navigation shortcuts">
            <h4>Navigation</h4>
            <ul className="shortcut-list">
              <li>
                <kbd>↑ / ↓</kbd>
                <span>Change day</span>
              </li>
              <li>
                <kbd>[ / ]</kbd>
                <span>Change day (alternate)</span>
              </li>
              <li>
                <kbd>← / →</kbd>
                <span>Previous or next capture</span>
              </li>
              <li>
                <kbd>J / K</kbd>
                <span>Capture stepping (alternate)</span>
              </li>
              <li>
                <kbd>Home / End</kbd>
                <span>Jump to first capture or now</span>
              </li>
            </ul>
          </section>

          <section className="shortcut-group" aria-label="Search and review shortcuts">
            <h4>Search and review</h4>
            <ul className="shortcut-list">
              <li>
                <kbd>/</kbd>
                <span>Focus search</span>
              </li>
              <li>
                <kbd>N / Shift+N</kbd>
                <span>Next or previous search result</span>
              </li>
              <li>
                <kbd>B</kbd>
                <span>Toggle bookmark</span>
              </li>
              <li>
                <kbd>F</kbd>
                <span>Toggle favorite</span>
              </li>
              <li>
                <kbd>Delete</kbd>
                <span>Delete selected capture</span>
              </li>
            </ul>
          </section>

          <section className="shortcut-group" aria-label="Capture control shortcuts">
            <h4>Capture controls</h4>
            <ul className="shortcut-list">
              <li>
                <kbd>Space</kbd>
                <span>Pause or resume capture</span>
              </li>
              <li>
                <kbd>C</kbd>
                <span>Capture now</span>
              </li>
              <li>
                <kbd>O</kbd>
                <span>Open captures folder</span>
              </li>
              <li>
                <kbd>T</kbd>
                <span>Jump to today</span>
              </li>
              <li>
                <kbd>S</kbd>
                <span>Open settings</span>
              </li>
            </ul>
          </section>

          <section className="shortcut-group" aria-label="Workspace shortcuts">
            <h4>Workspaces</h4>
            <ul className="shortcut-list">
              <li>
                <kbd>R</kbd>
                <span>Open Review workspace</span>
              </li>
              <li>
                <kbd>I</kbd>
                <span>Open Day Intelligence workspace</span>
              </li>
              <li>
                <kbd>V</kbd>
                <span>Return to Browse workspace</span>
              </li>
            </ul>
          </section>
        </div>

        <div className="quickstart-actions">
          <button className="secondary" type="button" onClick={onOpenSettings}>
            open settings
          </button>
          <button className="secondary" type="button" onClick={onClose}>
            close
          </button>
        </div>
      </section>
    </div>
  );
}

export function ConfirmationModal({
  body,
  confirmLabel,
  isConfirmDisabled = false,
  title,
  tone = "danger",
  onClose,
  onConfirm,
}: ConfirmationModalProps) {
  return (
    <div className="settings-overlay" role="presentation" onClick={onClose}>
      <section
        className="panel settings-modal confirmation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-modal-head">
          <div>
            <p className="section-title">Confirm action</p>
            <h3 id="confirmation-modal-title">{title}</h3>
          </div>
        </div>

        <section className="settings-section confirmation-modal-body">
          <div className="field-help">{body}</div>
        </section>

        <div className="quickstart-actions confirmation-modal-actions">
          <button className="secondary" type="button" onClick={onClose}>
            cancel
          </button>
          <button
            className={tone === "danger" ? "danger" : "secondary"}
            type="button"
            onClick={onConfirm}
            disabled={isConfirmDisabled}
          >
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export function TimelineStrip({
  captures,
  hasNewerPages,
  hasOlderPages,
  hourMarkers,
  isPageLoading,
  onCaptureNow,
  onClearSearch,
  onLoadNewer,
  onLoadOlder,
  onOpenSettings,
  onSelectCapture,
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
        <div className="timeline-title-group">
          <p className="section-title">Timeline</p>
          <h3>{formatRangeLabel(captures)}</h3>
        </div>
      </div>

      {captures.length === 0 ? (
        <div className="timeline-empty">
          <p>
            {searchQuery.trim().length > 0
              ? "No screenshots match this search for the selected day."
              : selectedDayCaptureCount > 0
                ? "No screenshots in this page window yet."
                : "No screenshots yet for this day."}
          </p>
          <p className="muted">
            {searchQuery.trim().length > 0
              ? "Clear search or broaden filters to bring captures back into view."
              : selectedDayCaptureCount > 0
                ? "Try loading older or newer pages from the timeline controls."
                : "Capture now or adjust cadence to begin building the timeline."}
          </p>
          <div className="empty-actions">
            {searchQuery.trim().length > 0 ? (
              <button className="secondary compact" type="button" onClick={onClearSearch}>
                clear search
              </button>
            ) : (
              <>
                <button className="secondary compact" type="button" onClick={onCaptureNow}>
                  capture now
                </button>
                <button className="secondary compact" type="button" onClick={onOpenSettings}>
                  open settings
                </button>
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="timeline-scroll-shell">
            <button
              className="timeline-page-button"
              type="button"
              onClick={onLoadOlder}
              disabled={!hasOlderPages || isPageLoading}
              aria-label="Load older captures"
            >
              <ChevronLeft className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
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
                  <div className="thumb-info">
                    <span className="thumb-time">{capture.timestampLabel}</span>
                    {capture.isFavorite ? (
                      <Star className="lucide-icon thumb-star" size={13} strokeWidth={1.8} aria-hidden="true" />
                    ) : null}
                  </div>
                </button>
              ))}
              {trailingSpacerWidth > 0 ? <div className="timeline-spacer" style={{ width: `${trailingSpacerWidth}px` }} /> : null}
            </div>

            <button
              className="timeline-page-button"
              type="button"
              onClick={onLoadNewer}
              disabled={!hasNewerPages || isPageLoading}
              aria-label="Load newer captures"
            >
              <ChevronRight className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            </button>
          </div>

          <div className="timeline-footer">
            <div
              className="hour-markers"
              style={{ gridTemplateColumns: `repeat(${Math.max(hourMarkers.length, 1)}, minmax(0, 1fr))` }}
            >
              {(hourMarkers.length > 0 ? hourMarkers : ["Waiting for first capture"]).map((marker) => (
                <span key={marker}>{marker}</span>
              ))}
            </div>

            <div className="timeline-progress-track">
              <div
                className="timeline-progress-fill"
                style={{ width: `${captures.length > 1 ? ((selectedCaptureIndex / (captures.length - 1)) * 100) : 0}%` }}
              />
            </div>

            <div className="timeline-footer-meta">
              <span className="timeline-count">
                {searchQuery.trim().length > 0
                  ? `${captures.length} filtered`
                  : `${selectedDayCaptureCount} captures`}
              </span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
