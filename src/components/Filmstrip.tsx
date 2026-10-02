import { useCallback, useRef, type MutableRefObject } from "react";
import { ChevronLeft, ChevronRight, Star } from "lucide-react";
import type { CaptureRecord } from "../types";
import { ICON_STROKE_WIDTH } from "../constants";
import { formatRangeLabel } from "../utils/app";
import { prefersReducedMotion } from "../utils/motion";

type FilmstripProps = {
  captures: CaptureRecord[];
  hasNewerPages: boolean;
  hasOlderPages: boolean;
  isPageLoading: boolean;
  leadingSpacerWidth: number;
  searchQuery: string;
  selectedCaptureId: number | null;
  selectedDayCaptureCount: number;
  thumbRefs: MutableRefObject<Record<number, HTMLButtonElement | null>>;
  trailingSpacerWidth: number;
  virtualCaptures: CaptureRecord[];
  onCaptureNow: () => void;
  onClearSearch: () => void;
  onLoadNewer: () => void;
  onLoadOlder: () => void;
  onSelectCapture: (captureId: number) => void;
};

/** Distance (px) over which neighbouring thumbnails magnify, like the macOS Dock. */
const MAGNIFY_RADIUS = 150;

export function Filmstrip({
  captures,
  hasNewerPages,
  hasOlderPages,
  isPageLoading,
  leadingSpacerWidth,
  searchQuery,
  selectedCaptureId,
  selectedDayCaptureCount,
  thumbRefs,
  trailingSpacerWidth,
  virtualCaptures,
  onCaptureNow,
  onClearSearch,
  onLoadNewer,
  onLoadOlder,
  onSelectCapture,
}: FilmstripProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const pointerXRef = useRef<number | null>(null);
  const isFiltered = searchQuery.trim().length > 0;

  const applyMagnification = useCallback(() => {
    frameRef.current = null;
    const track = trackRef.current;
    const pointerX = pointerXRef.current;
    if (!track) {
      return;
    }

    for (const thumb of track.querySelectorAll<HTMLElement>(".film-thumb")) {
      if (pointerX === null) {
        thumb.style.setProperty("--mag", "0");
        continue;
      }
      const rect = thumb.getBoundingClientRect();
      const distance = Math.abs(pointerX - (rect.left + rect.width / 2));
      const magnitude = Math.max(0, 1 - distance / MAGNIFY_RADIUS);
      // Ease the falloff so the hovered thumb clearly leads its neighbours.
      thumb.style.setProperty("--mag", (magnitude * magnitude * (3 - 2 * magnitude)).toFixed(3));
    }
  }, []);

  const scheduleMagnification = useCallback(
    (pointerX: number | null) => {
      if (prefersReducedMotion()) {
        return;
      }
      pointerXRef.current = pointerX;
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(applyMagnification);
      }
    },
    [applyMagnification],
  );

  if (captures.length === 0) {
    return (
      <section className="filmstrip filmstrip-empty">
        <p>
          {isFiltered
            ? "No captures on this day match your search."
            : selectedDayCaptureCount > 0
              ? "No captures loaded for this range."
              : "No captures yet for this day."}
        </p>
        {isFiltered ? (
          <button className="button button-small" type="button" onClick={onClearSearch}>
            Clear Search
          </button>
        ) : selectedDayCaptureCount === 0 ? (
          <button className="button button-small" type="button" onClick={onCaptureNow}>
            Capture Now
          </button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="filmstrip" aria-label="Capture timeline">
      <header className="filmstrip-head">
        <span className="filmstrip-range">{formatRangeLabel(captures).replace(" to ", " – ")}</span>
        <span className="filmstrip-count">
          {isFiltered ? `${captures.length} of ${selectedDayCaptureCount}` : `${selectedDayCaptureCount} captures`}
        </span>
      </header>

      <div className="filmstrip-body">
        {hasOlderPages ? (
          <button className="filmstrip-page" type="button" onClick={onLoadOlder} disabled={isPageLoading} aria-label="Load earlier captures" title="Load earlier captures">
            <ChevronLeft className="lucide-icon" size={16} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </button>
        ) : null}

        <div
          ref={trackRef}
          className="filmstrip-track"
          onMouseMove={(event) => scheduleMagnification(event.clientX)}
          onMouseLeave={() => scheduleMagnification(null)}
          onScroll={() => scheduleMagnification(pointerXRef.current)}
        >
          {leadingSpacerWidth > 0 ? <div className="filmstrip-spacer" style={{ width: leadingSpacerWidth }} /> : null}
          {virtualCaptures.map((capture) => {
            const isActive = capture.id === selectedCaptureId;
            return (
              <button
                key={capture.id}
                ref={(element) => {
                  thumbRefs.current[capture.id] = element;
                }}
                className={isActive ? "film-thumb active" : "film-thumb"}
                type="button"
                aria-current={isActive ? "true" : undefined}
                aria-label={`Capture at ${capture.timestampLabel}`}
                onClick={() => onSelectCapture(capture.id)}
              >
                <span className="film-thumb-frame">
                  <img src={capture.thumbnailDataUrl} alt="" draggable={false} />
                  {capture.isFavorite ? (
                    <Star className="lucide-icon film-thumb-star" size={11} strokeWidth={2} aria-hidden="true" />
                  ) : null}
                </span>
                <span className="film-thumb-time">{capture.timestampLabel}</span>
              </button>
            );
          })}
          {trailingSpacerWidth > 0 ? <div className="filmstrip-spacer" style={{ width: trailingSpacerWidth }} /> : null}
        </div>

        {hasNewerPages ? (
          <button className="filmstrip-page" type="button" onClick={onLoadNewer} disabled={isPageLoading} aria-label="Load later captures" title="Load later captures">
            <ChevronRight className="lucide-icon" size={16} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </section>
  );
}
