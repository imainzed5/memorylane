import { useCallback, useRef, useState } from "react";
import { BookmarkCheck, CalendarDays, Clock3, Filter, LayoutGrid, Sparkles } from "lucide-react";
import type { DaySummary, WorkspaceMode } from "../types";
import { ICON_SIZE, ICON_STROKE_WIDTH } from "../constants";
import { dayKeyFromDate, formatDaySecondary, formatViewerDate } from "../utils/app";
import { useDismiss, useSlidingIndicator } from "./primitives";

type SidebarProps = {
  isRecording: boolean;
  recentDays: DaySummary[];
  selectedDayKey: string;
  todayKey: string;
  workspaceMode: WorkspaceMode;
  onApplyStructuredFilter: (query: string) => void;
  onHideDayTooltip?: () => void;
  onOpenWorkspace: (mode: WorkspaceMode) => void;
  onSelectDay: (dayKey: string) => void;
  onShowDayTooltip?: (event: React.MouseEvent, dayKey: string, captureCount: number) => void;
};

const NAV_ITEMS: Array<{ mode: WorkspaceMode; label: string; icon: typeof Clock3 }> = [
  { mode: "browse", label: "Timeline", icon: Clock3 },
  { mode: "calendar", label: "Calendar", icon: CalendarDays },
  { mode: "all-captures", label: "All Captures", icon: LayoutGrid },
  { mode: "review", label: "Review", icon: BookmarkCheck },
  { mode: "intelligence", label: "Intelligence", icon: Sparkles },
];

const VISIBLE_DAY_COUNT = 7;

export function Sidebar({
  isRecording,
  recentDays,
  selectedDayKey,
  todayKey,
  workspaceMode,
  onApplyStructuredFilter,
  onHideDayTooltip,
  onOpenWorkspace,
  onSelectDay,
  onShowDayTooltip,
}: SidebarProps) {
  const navRef = useRef<HTMLElement | null>(null);
  const navIndicator = useSlidingIndicator(navRef, workspaceMode, "y");
  const daysRef = useRef<HTMLDivElement | null>(null);
  const visibleDays = recentDays.slice(0, VISIBLE_DAY_COUNT);
  const dayIndicator = useSlidingIndicator(daysRef, workspaceMode === "browse" ? selectedDayKey : null, "y");
  const yesterdayKey = dayKeyFromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));

  return (
    <aside className="sidebar" data-tauri-drag-region>
      <div className="sidebar-brand" data-tauri-drag-region>
        <img src="/memorylane-icon-64.png" alt="" />
        <strong>MemoryLane</strong>
        <span
          className={isRecording ? "recording-dot is-live" : "recording-dot"}
          title={isRecording ? "Recording" : "Paused"}
          aria-label={isRecording ? "Recording" : "Recording paused"}
        />
      </div>

      <nav ref={navRef} className="sidebar-nav" aria-label="Library">
        <span className={navIndicator.ready ? "sidebar-pill is-ready" : "sidebar-pill"} style={navIndicator.style} aria-hidden="true" />
        {NAV_ITEMS.map(({ mode, label, icon: Icon }) => (
          <button
            key={mode}
            className={workspaceMode === mode ? "sidebar-item active" : "sidebar-item"}
            type="button"
            data-indicator-key={mode}
            aria-current={workspaceMode === mode ? "page" : undefined}
            onClick={() => onOpenWorkspace(mode)}
          >
            <Icon className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <section className="sidebar-days">
        <p className="sidebar-heading">Days</p>
        <div ref={daysRef} className="sidebar-day-list">
          <span className={dayIndicator.ready ? "sidebar-pill sidebar-pill-quiet is-ready" : "sidebar-pill sidebar-pill-quiet"} style={dayIndicator.style} aria-hidden="true" />
          {visibleDays.map((day) => {
            const isSelected = day.dayKey === selectedDayKey;
            const title =
              day.dayKey === todayKey ? "Today" : day.dayKey === yesterdayKey ? "Yesterday" : formatViewerDate(day.dayKey);
            const subtitle = day.dayKey === todayKey || day.dayKey === yesterdayKey ? formatDaySecondary(day.dayKey) : null;

            return (
              <button
                key={day.dayKey}
                className={isSelected ? "sidebar-day selected" : "sidebar-day"}
                type="button"
                data-indicator-key={day.dayKey}
                onClick={() => {
                  onHideDayTooltip?.();
                  onSelectDay(day.dayKey);
                }}
                onMouseEnter={(event) => onShowDayTooltip?.(event, day.dayKey, day.captureCount)}
                onMouseLeave={onHideDayTooltip}
              >
                <span className="sidebar-day-copy">
                  <span className="sidebar-day-title">{title}</span>
                  {subtitle ? <span className="sidebar-day-subtitle">{subtitle}</span> : null}
                </span>
                <span className="sidebar-day-count" aria-label={`${day.captureCount} captures`}>
                  {day.captureCount}
                </span>
              </button>
            );
          })}
        </div>
        {recentDays.length > visibleDays.length ? (
          <button className="sidebar-link" type="button" onClick={() => onOpenWorkspace("calendar")}>
            All days…
          </button>
        ) : null}
      </section>

      <FilterPopover selectedDayKey={selectedDayKey} todayKey={todayKey} onApplyStructuredFilter={onApplyStructuredFilter} />
    </aside>
  );
}

type FilterPopoverProps = {
  selectedDayKey: string;
  todayKey: string;
  onApplyStructuredFilter: (query: string) => void;
};

function FilterPopover({ selectedDayKey, todayKey, onApplyStructuredFilter }: FilterPopoverProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(containerRef, isOpen, close);

  const apply = (query: string) => {
    onApplyStructuredFilter(query);
    setIsOpen(false);
  };
  const normalizedTag = tagDraft.trim().replace(/^#/, "");

  return (
    <div ref={containerRef} className="sidebar-footer">
      <button
        className={isOpen ? "sidebar-item sidebar-filter active" : "sidebar-item sidebar-filter"}
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
      >
        <Filter className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
        <span>Filters</span>
      </button>

      {isOpen ? (
        <div className="filter-popover popover" role="dialog" aria-label="Capture filters">
          <p className="popover-label">Show captures that are</p>
          <div className="filter-grid">
            <button className="chip" type="button" onClick={() => apply("bookmarked")}>Bookmarked</button>
            <button className="chip" type="button" onClick={() => apply("favorite")}>Favorites</button>
            <button className="chip" type="button" onClick={() => apply("bookmarked favorite")}>Bookmarked + Favorite</button>
            <button className="chip" type="button" onClick={() => apply("ocr")}>With OCR Text</button>
            <button className="chip" type="button" onClick={() => apply("redact")}>Redacted</button>
          </div>
          <p className="popover-label">From</p>
          <div className="filter-grid">
            <button className="chip" type="button" onClick={() => apply(todayKey)}>Today</button>
            <button className="chip" type="button" onClick={() => apply("yesterday")}>Yesterday</button>
            <button className="chip" type="button" onClick={() => apply(selectedDayKey)}>Selected Day</button>
          </div>
          <form
            className="filter-tag-row"
            onSubmit={(event) => {
              event.preventDefault();
              if (normalizedTag) {
                apply(`tag:${normalizedTag}`);
              }
            }}
          >
            <input value={tagDraft} placeholder="Tag, e.g. roadmap" aria-label="Filter by tag" onChange={(event) => setTagDraft(event.currentTarget.value)} />
            <button className="button button-accent" type="submit" disabled={!normalizedTag}>
              Apply
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
