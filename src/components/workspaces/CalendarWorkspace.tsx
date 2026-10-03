import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import type { DaySummary } from "../../types";
import { ICON_STROKE_WIDTH } from "../../constants";
import { dayDateFromKey, dayKeyFromDate } from "../../utils/app";
import { useContextMenu } from "../ContextMenu";
import { WorkspaceHeader } from "../primitives";

type CalendarWorkspaceProps = {
  daySummaries: DaySummary[];
  selectedDayKey: string;
  todayKey: string;
  onDeleteDay: (dayKey: string) => void;
  onSelectDay: (dayKey: string) => void;
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type CalendarCell =
  | { kind: "pad"; key: string }
  | { kind: "day"; key: string; dayKey: string; dayNumber: number; summary: DaySummary | undefined };

export function CalendarWorkspace({ daySummaries, selectedDayKey, todayKey, onDeleteDay, onSelectDay }: CalendarWorkspaceProps) {
  const openContextMenu = useContextMenu();
  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const anchor = dayDateFromKey(selectedDayKey);
    return new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  });
  const [slideDirection, setSlideDirection] = useState<"next" | "previous" | null>(null);

  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const summaryByDay = useMemo(() => new Map(daySummaries.map((summary) => [summary.dayKey, summary])), [daySummaries]);

  const cells = useMemo<CalendarCell[]>(() => {
    const result: CalendarCell[] = [];
    const leadingPads = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let index = 0; index < leadingPads; index += 1) {
      result.push({ kind: "pad", key: `pad-start-${index}` });
    }
    for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
      const dayKey = dayKeyFromDate(new Date(year, month, dayNumber));
      result.push({ kind: "day", key: dayKey, dayKey, dayNumber, summary: summaryByDay.get(dayKey) });
    }
    while (result.length % 7 !== 0) {
      result.push({ kind: "pad", key: `pad-end-${result.length}` });
    }
    return result;
  }, [month, summaryByDay, year]);

  const monthStats = useMemo(() => {
    let recordedDays = 0;
    let captureTotal = 0;
    let busiest = 0;
    for (const cell of cells) {
      const count = cell.kind === "day" ? cell.summary?.captureCount ?? 0 : 0;
      if (count > 0) {
        recordedDays += 1;
        captureTotal += count;
        busiest = Math.max(busiest, count);
      }
    }
    return { recordedDays, captureTotal, busiest };
  }, [cells]);

  const shiftMonth = (step: number) => {
    setSlideDirection(step > 0 ? "next" : "previous");
    setViewMonth(new Date(year, month + step, 1));
  };

  const showToday = () => {
    const today = dayDateFromKey(todayKey);
    const target = new Date(today.getFullYear(), today.getMonth(), 1);
    if (target.getTime() !== viewMonth.getTime()) {
      setSlideDirection(target > viewMonth ? "next" : "previous");
      setViewMonth(target);
    }
  };

  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(viewMonth);
  const monthName = new Intl.DateTimeFormat("en-US", { month: "long" }).format(viewMonth);

  return (
    <main className="workspace calendar-workspace" data-workspace-pane>
      <WorkspaceHeader
        title={monthLabel}
        subtitle={
          monthStats.recordedDays > 0
            ? `${monthStats.recordedDays} day${monthStats.recordedDays === 1 ? "" : "s"} recorded in ${monthName} · ${monthStats.captureTotal} captures`
            : `Nothing recorded in ${monthName}`
        }
        accessory={
          <div className="button-group">
            <button className="button button-icon" type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month">
              <ChevronLeft className="lucide-icon" size={16} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            </button>
            <button className="button" type="button" onClick={showToday}>
              Today
            </button>
            <button className="button button-icon" type="button" onClick={() => shiftMonth(1)} aria-label="Next month">
              <ChevronRight className="lucide-icon" size={16} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            </button>
          </div>
        }
      />

      <div className="workspace-body calendar-body">
        <div className="calendar-weekdays" aria-hidden="true">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday}>{weekday}</span>
          ))}
        </div>

        <div
          key={`${year}-${month}`}
          className={["calendar-grid", slideDirection ? `slide-${slideDirection}` : ""].join(" ").trim()}
          style={{ gridTemplateRows: `repeat(${cells.length / 7}, minmax(0, 1fr))` }}
          role="grid"
          aria-label={monthLabel}
        >
          {cells.map((cell) => {
            if (cell.kind === "pad") {
              return <span key={cell.key} className="calendar-cell is-pad" aria-hidden="true" />;
            }

            const count = cell.summary?.captureCount ?? 0;
            const heat = count > 0 && monthStats.busiest > 0 ? 0.25 + 0.75 * (count / monthStats.busiest) : 0;
            const className = [
              "calendar-cell",
              count > 0 ? "has-captures" : "",
              cell.dayKey === todayKey ? "is-today" : "",
              cell.dayKey === selectedDayKey ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");

            return (
              <button
                key={cell.key}
                className={className}
                type="button"
                role="gridcell"
                style={{ "--heat": heat.toFixed(3) } as React.CSSProperties}
                disabled={count === 0}
                aria-label={`${dayDateFromKey(cell.dayKey).toDateString()}: ${count} captures`}
                onClick={() => onSelectDay(cell.dayKey)}
                onContextMenu={(event) =>
                  openContextMenu(
                    event,
                    [
                      { id: "open-day", label: "Open Day", icon: CalendarDays, onSelect: () => onSelectDay(cell.dayKey) },
                      { id: "sep-delete", separator: true },
                      { id: "delete-day", label: "Delete Day…", icon: Trash2, danger: true, onSelect: () => onDeleteDay(cell.dayKey) },
                    ],
                    dayDateFromKey(cell.dayKey).toDateString(),
                  )
                }
              >
                <span className="calendar-day-number">{cell.dayNumber}</span>
                {count > 0 ? (
                  <>
                    <DensitySparkline density={cell.summary?.density ?? []} />
                    <span className="calendar-count">{count}</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="calendar-legend" aria-hidden="true">
          <span>Less</span>
          {[0.25, 0.5, 0.75, 1].map((heat) => (
            <i key={heat} style={{ "--heat": heat } as React.CSSProperties} />
          ))}
          <span>More</span>
        </div>
      </div>
    </main>
  );
}

function DensitySparkline({ density }: { density: number[] }) {
  const peak = Math.max(...density, 0);
  if (density.length === 0 || peak <= 0) {
    return null;
  }

  return (
    <span className="calendar-sparkline" aria-hidden="true">
      {density.map((value, index) => (
        <i key={index} style={{ height: `${Math.max(8, (value / peak) * 100)}%` }} />
      ))}
    </span>
  );
}
