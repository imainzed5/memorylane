import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Star } from "lucide-react";
import type { CaptureRecord } from "../../types";
import { dayKeyFromDate, formatViewerDate } from "../../utils/app";
import { useContextMenu, type CaptureMenuBuilder } from "../ContextMenu";
import { WorkspaceHeader } from "../primitives";

type GalleryWorkspaceProps = {
  buildCaptureMenu: CaptureMenuBuilder;
  onSelectCapture: (captureId: number, source: HTMLElement | null) => void;
};

const PAGE_SIZE = 60;

export function GalleryWorkspace({ buildCaptureMenu, onSelectCapture }: GalleryWorkspaceProps) {
  const openContextMenu = useContextMenu();
  const [captures, setCaptures] = useState<CaptureRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadPage = useCallback(async (offset: number) => {
    if (loadingRef.current) {
      return;
    }
    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const page = await invoke<CaptureRecord[]>("get_all_captures_page", { offset, limit: PAGE_SIZE });
      setCaptures((current) => {
        if (offset === 0) {
          return page;
        }
        const seen = new Set(current.map((capture) => capture.id));
        return [...current, ...page.filter((capture) => !seen.has(capture.id))];
      });
    } catch (loadError) {
      setError(String(loadError ?? "Unable to load captures."));
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void invoke<number>("get_total_capture_count")
      .then(setTotalCount)
      .catch(() => undefined);
    void loadPage(0);
  }, [loadPage]);

  const hasMore = captures.length < totalCount;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadPage(captures.length);
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [captures.length, hasMore, loadPage]);

  const groups = useMemo(() => {
    const result: Array<{ dayKey: string; captures: CaptureRecord[] }> = [];
    for (const capture of captures) {
      const last = result[result.length - 1];
      if (last && last.dayKey === capture.dayKey) {
        last.captures.push(capture);
      } else {
        result.push({ dayKey: capture.dayKey, captures: [capture] });
      }
    }
    return result;
  }, [captures]);

  const todayKey = dayKeyFromDate(new Date());
  const yesterdayKey = dayKeyFromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const dayTitle = (dayKey: string) => (dayKey === todayKey ? "Today" : dayKey === yesterdayKey ? "Yesterday" : formatViewerDate(dayKey));

  return (
    <main className="workspace gallery-workspace" data-workspace-pane>
      <WorkspaceHeader title="All Captures" subtitle={`${totalCount} capture${totalCount === 1 ? "" : "s"} across your archive`} />

      <div className="workspace-body workspace-scroll">
        {error ? <p className="inline-warning">{error}</p> : null}

        {groups.map((group) => (
          <section key={group.dayKey} className="gallery-group">
            <h3 className="gallery-group-title">
              {dayTitle(group.dayKey)}
              <span>{group.captures.length}</span>
            </h3>
            <div className="gallery-grid">
              {group.captures.map((capture) => (
                <button
                  key={capture.id}
                  className="gallery-tile"
                  type="button"
                  onClick={(event) => onSelectCapture(capture.id, event.currentTarget.querySelector("img"))}
                  onContextMenu={(event) =>
                    openContextMenu(
                      event,
                      buildCaptureMenu(capture, {
                        surface: "gallery",
                        source: event.currentTarget.querySelector("img"),
                        onChange: (patch) =>
                          setCaptures((current) => current.map((item) => (item.id === capture.id ? { ...item, ...patch } : item))),
                      }),
                      `Capture at ${capture.timestampLabel}`,
                    )
                  }
                  title={capture.windowTitle || capture.processName || capture.timestampLabel}
                >
                  <span className="gallery-tile-frame">
                    <img src={capture.thumbnailDataUrl} alt={capture.windowTitle || "Capture preview"} loading="lazy" draggable={false} />
                    {capture.isFavorite ? <Star className="lucide-icon gallery-tile-star" size={12} strokeWidth={2} aria-hidden="true" /> : null}
                  </span>
                  <span className="gallery-tile-caption">
                    <strong>{capture.timestampLabel}</strong>
                    <span>{capture.processName.trim() || "Unknown app"}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {!isLoading && captures.length === 0 && !error ? (
          <div className="empty-state">
            <h3>No captures yet</h3>
            <p>Captures appear here as soon as MemoryLane records your first screenshot.</p>
          </div>
        ) : null}

        <div ref={sentinelRef} className="gallery-sentinel" aria-hidden="true" />
        {isLoading ? <p className="gallery-status">Loading…</p> : null}
      </div>
    </main>
  );
}
