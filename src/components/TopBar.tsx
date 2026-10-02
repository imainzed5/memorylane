import { useCallback, useRef, useState, type MutableRefObject } from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Keyboard,
  Minus,
  MoreHorizontal,
  PanelRight,
  Search,
  Settings,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type { RetrievalSearchResult } from "../types";
import { ICON_SIZE, ICON_STROKE_WIDTH, SEARCH_SUGGESTIONS } from "../constants";
import { formatMatchSourceLabel, formatViewerDate, renderHighlightedSnippet } from "../utils/app";
import { Kbd, useDismiss } from "./primitives";

type SearchFieldProps = {
  activeResultIndex: number;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  isLoading: boolean;
  ocrWarning: string | null;
  query: string;
  results: RetrievalSearchResult[];
  resultsError: string | null;
  onActiveResultIndexChange: (index: number) => void;
  onQueryChange: (query: string) => void;
  onSelectResult: (result: RetrievalSearchResult) => void;
};

export type TopBarProps = {
  canDeleteDay: boolean;
  dayCaptureCount: number;
  dayLabel: string;
  hasNextDay: boolean;
  hasPreviousDay: boolean;
  isInspectorOpen: boolean;
  isTodaySelected: boolean;
  isWindowMaximized: boolean;
  search: SearchFieldProps;
  onCloseWindow: () => void;
  onDeleteDay: () => void;
  onJumpToToday: () => void;
  onMinimizeWindow: () => void;
  onOpenCalendar: () => void;
  onOpenCapturesFolder: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onSelectNextDay: () => void;
  onSelectPreviousDay: () => void;
  onToggleInspector: () => void;
  onToggleWindowMaximize: () => void;
};

export function TopBar({
  canDeleteDay,
  dayCaptureCount,
  dayLabel,
  hasNextDay,
  hasPreviousDay,
  isInspectorOpen,
  isTodaySelected,
  isWindowMaximized,
  search,
  onCloseWindow,
  onDeleteDay,
  onJumpToToday,
  onMinimizeWindow,
  onOpenCalendar,
  onOpenCapturesFolder,
  onOpenSettings,
  onOpenShortcuts,
  onSelectNextDay,
  onSelectPreviousDay,
  onToggleInspector,
  onToggleWindowMaximize,
}: TopBarProps) {
  return (
    <header className="toolbar" data-tauri-drag-region>
      <div className="toolbar-day" data-tauri-drag-region>
        <div className="toolbar-stepper" role="group" aria-label="Change day">
          <button className="toolbar-icon-button" type="button" onClick={onSelectPreviousDay} disabled={!hasPreviousDay} aria-label="Previous day" title="Previous day">
            <ChevronLeft className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </button>
          <button className="toolbar-icon-button" type="button" onClick={onSelectNextDay} disabled={!hasNextDay} aria-label="Next day" title="Next day">
            <ChevronRight className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </button>
        </div>

        <button className="toolbar-title" type="button" onClick={onOpenCalendar} title="Open calendar">
          <strong>{dayLabel}</strong>
          <span>
            {dayCaptureCount} capture{dayCaptureCount === 1 ? "" : "s"}
          </span>
        </button>

        {!isTodaySelected ? (
          <button className="pill-button" type="button" onClick={onJumpToToday}>
            Today
          </button>
        ) : null}
      </div>

      <div className="toolbar-trailing">
        <SearchField {...search} />

        <button
          className={isInspectorOpen ? "toolbar-icon-button active" : "toolbar-icon-button"}
          type="button"
          onClick={onToggleInspector}
          aria-pressed={isInspectorOpen}
          aria-label={isInspectorOpen ? "Hide inspector" : "Show inspector"}
          title={isInspectorOpen ? "Hide inspector" : "Show inspector"}
        >
          <PanelRight className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
        </button>

        <MoreMenu
          canDeleteDay={canDeleteDay}
          dayLabel={dayLabel}
          onDeleteDay={onDeleteDay}
          onOpenCapturesFolder={onOpenCapturesFolder}
          onOpenSettings={onOpenSettings}
          onOpenShortcuts={onOpenShortcuts}
        />

        <div className="window-controls" role="toolbar" aria-label="Window controls">
          <button className="window-control" type="button" title="Minimize" aria-label="Minimize window" onClick={onMinimizeWindow}>
            <Minus className="lucide-icon" size={14} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <button
            className="window-control"
            type="button"
            title={isWindowMaximized ? "Restore" : "Maximize"}
            aria-label={isWindowMaximized ? "Restore window" : "Maximize window"}
            onClick={onToggleWindowMaximize}
          >
            <Square className="lucide-icon" size={11} strokeWidth={1.6} aria-hidden="true" />
          </button>
          <button className="window-control window-control-close" type="button" title="Close" aria-label="Close window" onClick={onCloseWindow}>
            <X className="lucide-icon" size={15} strokeWidth={1.6} aria-hidden="true" />
          </button>
        </div>
      </div>
    </header>
  );
}

function SearchField({
  activeResultIndex,
  inputRef,
  isLoading,
  ocrWarning,
  query,
  results,
  resultsError,
  onActiveResultIndexChange,
  onQueryChange,
  onSelectResult,
}: SearchFieldProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  // The input handles Escape itself: first press clears the query, second closes.
  useDismiss(containerRef, isOpen, close, { closeOnEscape: false });

  const trimmed = query.trim();
  const hasQuery = trimmed.length > 0;

  const selectResult = (result: RetrievalSearchResult) => {
    onSelectResult(result);
    setIsOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={containerRef} className={isOpen ? "search-field is-open" : "search-field"}>
      <Search className="lucide-icon search-field-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder="Search captures"
        aria-label="Search notes, OCR text, and apps"
        aria-expanded={isOpen}
        aria-controls="search-results"
        onFocus={() => setIsOpen(true)}
        onChange={(event) => {
          onQueryChange(event.currentTarget.value);
          setIsOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && results.length > 0) {
            event.preventDefault();
            onActiveResultIndexChange((activeResultIndex + 1) % results.length);
          } else if (event.key === "ArrowUp" && results.length > 0) {
            event.preventDefault();
            onActiveResultIndexChange((activeResultIndex - 1 + results.length) % results.length);
          } else if (event.key === "Enter" && results.length > 0) {
            event.preventDefault();
            selectResult(results[Math.max(0, activeResultIndex)]);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (hasQuery) {
              onQueryChange("");
            } else {
              setIsOpen(false);
              event.currentTarget.blur();
            }
          }
        }}
      />
      {hasQuery ? (
        <button className="search-field-clear" type="button" aria-label="Clear search" onClick={() => onQueryChange("")}>
          <X className="lucide-icon" size={12} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : (
        <Kbd>Ctrl K</Kbd>
      )}

      {isOpen ? (
        <div className="search-popover popover" id="search-results" role="listbox" aria-label="Search results">
          {ocrWarning ? <p className="popover-note warning">{ocrWarning}</p> : null}

          {!hasQuery ? (
            <>
              <p className="popover-label">Try</p>
              <div className="search-suggestions">
                {SEARCH_SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} className="chip" type="button" onClick={() => onQueryChange(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
              <p className="popover-note">
                Searches notes, OCR text, apps and windows. Filters: <code>app:</code> <code>window:</code> <code>tag:</code>{" "}
                <code>bookmarked</code> <code>favorite</code>
              </p>
            </>
          ) : isLoading || trimmed.length < 2 ? (
            <p className="popover-note">{trimmed.length < 2 ? "Keep typing…" : "Searching your archive…"}</p>
          ) : resultsError ? (
            <p className="popover-note warning">{resultsError}</p>
          ) : results.length === 0 ? (
            <p className="popover-note">No matches. Try broader words or a time hint like "around 2 PM".</p>
          ) : (
            <>
              <p className="popover-label">
                {results.length} result{results.length === 1 ? "" : "s"}
                <span>
                  <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> to move, <Kbd>Enter</Kbd> to open
                </span>
              </p>
              <div className="search-results">
                {results.map((result, index) => (
                  <button
                    key={result.captureId}
                    className={index === activeResultIndex ? "search-result active" : "search-result"}
                    type="button"
                    role="option"
                    aria-selected={index === activeResultIndex}
                    onMouseEnter={() => onActiveResultIndexChange(index)}
                    onClick={() => selectResult(result)}
                  >
                    <span className="search-result-head">
                      <strong>
                        {formatViewerDate(result.dayKey)} · {result.timestampLabel}
                      </strong>
                      <span className="search-result-badges">
                        {result.isFavorite ? <span className="tag">favorite</span> : null}
                        {result.isBookmarked ? <span className="tag">bookmarked</span> : null}
                        {result.matchSources.slice(0, 2).map((source) => (
                          <span key={`${result.captureId}-${source}`} className="tag tag-quiet">
                            {formatMatchSourceLabel(source)}
                          </span>
                        ))}
                      </span>
                    </span>
                    <small>{renderHighlightedSnippet(result.snippet, result.highlightTerms) || result.matchReason}</small>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

type MoreMenuProps = {
  canDeleteDay: boolean;
  dayLabel: string;
  onDeleteDay: () => void;
  onOpenCapturesFolder: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
};

function MoreMenu({ canDeleteDay, dayLabel, onDeleteDay, onOpenCapturesFolder, onOpenSettings, onOpenShortcuts }: MoreMenuProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(containerRef, isOpen, close);

  const run = (action: () => void) => () => {
    setIsOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="menu-anchor">
      <button
        className={isOpen ? "toolbar-icon-button active" : "toolbar-icon-button"}
        type="button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label="More"
        title="More"
        onClick={() => setIsOpen((current) => !current)}
      >
        <MoreHorizontal className="lucide-icon" size={ICON_SIZE} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
      </button>

      {isOpen ? (
        <div className="menu popover" role="menu">
          <button className="menu-item" type="button" role="menuitem" onClick={run(onOpenSettings)}>
            <Settings className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span>Settings</span>
            <Kbd>S</Kbd>
          </button>
          <button className="menu-item" type="button" role="menuitem" onClick={run(onOpenShortcuts)}>
            <Keyboard className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span>Keyboard Shortcuts</span>
            <Kbd>?</Kbd>
          </button>
          <button className="menu-item" type="button" role="menuitem" onClick={run(onOpenCapturesFolder)}>
            <FolderOpen className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span>Open Captures Folder</span>
            <Kbd>O</Kbd>
          </button>
          <div className="menu-separator" role="separator" />
          <button className="menu-item menu-item-danger" type="button" role="menuitem" onClick={run(onDeleteDay)} disabled={!canDeleteDay}>
            <Trash2 className="lucide-icon" size={15} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span>Delete {dayLabel}…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
