import { useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { CaptureRecord } from "../types";
import { formatViewerDate } from "../utils/app";
import { Kbd } from "./primitives";
import { captureAspectRatio } from "./Viewer";

type QuickLookProps = {
  capture: CaptureRecord;
  imageDataUrl: string | null;
  index: number;
  total: number;
  onClose: (source: HTMLElement | null) => void;
  onNext: () => void;
  onPrevious: () => void;
};

/** Full-window preview in the spirit of macOS Quick Look. Space or Esc closes it. */
export function QuickLook({ capture, imageDataUrl, index, total, onClose, onNext, onPrevious }: QuickLookProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const close = () => onClose(imageRef.current);

  return (
    <div className="quicklook" role="dialog" aria-modal="true" aria-label={`Quick Look: ${capture.timestampLabel}`} onClick={close}>
      <header className="quicklook-bar" onClick={(event) => event.stopPropagation()}>
        <div className="quicklook-title">
          <strong>{capture.timestampLabel}</strong>
          <span>
            {formatViewerDate(capture.dayKey)} · {capture.processName.trim() || "Unknown app"}
          </span>
        </div>
        <span className="quicklook-count">
          {index + 1} of {total}
        </span>
        <button className="quicklook-close" type="button" onClick={close} aria-label="Close Quick Look" title="Close (Space)">
          <X className="lucide-icon" size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <img
        ref={imageRef}
        className="quicklook-image"
        src={imageDataUrl ?? capture.thumbnailDataUrl}
        alt={`Screenshot captured at ${capture.timestampLabel}`}
        style={{ "--ratio": captureAspectRatio(capture) } as React.CSSProperties}
        data-hero="quicklook"
        onClick={(event) => event.stopPropagation()}
      />

      <button
        className="quicklook-step quicklook-step-left"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onPrevious();
        }}
        disabled={index <= 0}
        aria-label="Previous capture"
      >
        <ChevronLeft className="lucide-icon" size={22} strokeWidth={2} aria-hidden="true" />
      </button>
      <button
        className="quicklook-step quicklook-step-right"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onNext();
        }}
        disabled={index >= total - 1}
        aria-label="Next capture"
      >
        <ChevronRight className="lucide-icon" size={22} strokeWidth={2} aria-hidden="true" />
      </button>

      <p className="quicklook-hint">
        <Kbd>←</Kbd> <Kbd>→</Kbd> to browse · <Kbd>Space</Kbd> to close
      </p>
    </div>
  );
}
