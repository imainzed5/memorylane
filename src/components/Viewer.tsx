import { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  Expand,
  Info,
  Layers3,
  Shield,
  Star,
  Trash2,
} from "lucide-react";
import type { CaptureHealthPayload, CaptureRecord } from "../types";
import { ICON_SIZE, ICON_STROKE_WIDTH } from "../constants";
import { formatCaptureTimestamp, formatViewerDate } from "../utils/app";
import { Kbd, useDismiss } from "./primitives";

type ViewerProps = {
  captureHealth: CaptureHealthPayload;
  captures: CaptureRecord[];
  compareCaptureLabel: string | null;
  compareImageDataUrl: string | null;
  contextBadge: string;
  dayCaptureCount: number;
  isFilterActive: boolean;
  selectedCapture: CaptureRecord | null;
  selectedCaptureIndex: number;
  selectedImageDataUrl: string | null;
  onCaptureNow: () => void;
  onClearCompareAnchor: () => void;
  onClearSearch: () => void;
  onCopyPath: () => void;
  onDeleteCapture: () => void;
  onOpenCapturesFolder: () => void;
  onOpenQuickLook: (source: HTMLElement | null) => void;
  onOpenSettings: () => void;
  onRedactCapture: () => void;
  onSelectNext: () => void;
  onSelectPrevious: () => void;
  onSetCompareAnchor: () => void;
  onToggleBookmark: () => void;
  onToggleFavorite: () => void;
};

export function Viewer({
  captureHealth,
  captures,
  compareCaptureLabel,
  compareImageDataUrl,
  contextBadge,
  dayCaptureCount,
  isFilterActive,
  selectedCapture,
  selectedCaptureIndex,
  selectedImageDataUrl,
  onCaptureNow,
  onClearCompareAnchor,
  onClearSearch,
  onCopyPath,
  onDeleteCapture,
  onOpenCapturesFolder,
  onOpenQuickLook,
  onOpenSettings,
  onRedactCapture,
  onSelectNext,
  onSelectPrevious,
  onSetCompareAnchor,
  onToggleBookmark,
  onToggleFavorite,
}: ViewerProps) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const hasCompareAnchor = Boolean(compareCaptureLabel);
  const healthWarning =
    captureHealth.consecutiveFailures > 0 && captureHealth.lastError
      ? `Capture is failing (${captureHealth.consecutiveFailures}×): ${captureHealth.lastError}`
      : null;

  if (!selectedCapture || captures.length === 0) {
    return (
      <main className="stage stage-empty" data-workspace-pane>
        {healthWarning ? <StageWarning message={healthWarning} /> : null}
        <div className="empty-state">
          <h3>{isFilterActive ? "No captures match" : "Nothing captured yet"}</h3>
          <p>
            {isFilterActive
              ? "Try a broader phrase, remove a filter, or pick another day."
              : "MemoryLane captures quietly in the background and keeps running from the tray after you close the window."}
          </p>
          <div className="empty-actions">
            {isFilterActive ? (
              <button className="button" type="button" onClick={onClearSearch}>
                Clear Search
              </button>
            ) : (
              <>
                <button className="button button-accent" type="button" onClick={onCaptureNow}>
                  Capture Now
                </button>
                <button className="button" type="button" onClick={onOpenSettings}>
                  Capture Settings
                </button>
              </>
            )}
            <button className="button button-plain" type="button" onClick={onOpenCapturesFolder}>
              Open Captures Folder
            </button>
          </div>
          <p className="empty-hint">
            Press <Kbd>?</Kbd> for keyboard shortcuts
          </p>
        </div>
      </main>
    );
  }

  const displayedImage = selectedImageDataUrl ?? selectedCapture.thumbnailDataUrl;
  const isPlaceholder = !selectedImageDataUrl;
  const appLabel = selectedCapture.processName.trim() || "Unknown app";
  const windowLabel = selectedCapture.windowTitle.trim();
  const ratioStyle = { "--ratio": captureAspectRatio(selectedCapture) } as React.CSSProperties;

  return (
    <main className="stage" data-workspace-pane>
      <div className="stage-caption">
        <div className="stage-caption-main">
          <strong>{selectedCapture.timestampLabel}</strong>
          <span title={contextBadge}>
            {appLabel}
            {windowLabel ? ` — ${windowLabel}` : ""}
          </span>
        </div>
        <span className="stage-caption-count">
          {selectedCaptureIndex + 1} of {captures.length}
          {isFilterActive ? ` (filtered from ${dayCaptureCount})` : ""}
        </span>
      </div>

      {healthWarning ? <StageWarning message={healthWarning} /> : null}

      <div className="stage-canvas">
        {hasCompareAnchor ? (
          <div className="compare-grid">
            <figure className="compare-panel">
              <figcaption>
                <span>Compare anchor</span>
                <strong>{compareCaptureLabel}</strong>
              </figcaption>
              {compareImageDataUrl ? (
                <img className="stage-image" src={compareImageDataUrl} alt="Compare anchor screenshot" />
              ) : (
                <div className="stage-loading">Loading…</div>
              )}
            </figure>
            <figure className="compare-panel">
              <figcaption>
                <span>Selected</span>
                <strong>{selectedCapture.timestampLabel}</strong>
              </figcaption>
              <img
                className={isPlaceholder ? "stage-image is-placeholder" : "stage-image"}
                src={displayedImage}
                alt={`Screenshot captured at ${selectedCapture.timestampLabel}`}
              />
            </figure>
          </div>
        ) : (
          <img
            ref={imageRef}
            key={selectedCapture.id}
            className={isPlaceholder ? "stage-image is-placeholder" : "stage-image"}
            src={displayedImage}
            alt={`Screenshot captured at ${selectedCapture.timestampLabel}`}
            style={ratioStyle}
            data-hero="viewer"
            onDoubleClick={() => onOpenQuickLook(imageRef.current)}
          />
        )}

        <button
          className="stage-step stage-step-left"
          type="button"
          onClick={onSelectPrevious}
          disabled={selectedCaptureIndex <= 0}
          aria-label="Previous capture"
        >
          <ChevronLeft className="lucide-icon" size={20} strokeWidth={2} aria-hidden="true" />
        </button>
        <button
          className="stage-step stage-step-right"
          type="button"
          onClick={onSelectNext}
          disabled={selectedCaptureIndex >= captures.length - 1}
          aria-label="Next capture"
        >
          <ChevronRight className="lucide-icon" size={20} strokeWidth={2} aria-hidden="true" />
        </button>

        <div className="stage-toolbar" role="toolbar" aria-label="Capture actions">
          <ToolButton
            label={selectedCapture.isBookmarked ? "Remove bookmark (B)" : "Bookmark (B)"}
            active={selectedCapture.isBookmarked}
            onClick={onToggleBookmark}
          >
            <Bookmark className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </ToolButton>
          <ToolButton
            label={selectedCapture.isFavorite ? "Remove favorite (F)" : "Favorite (F)"}
            active={selectedCapture.isFavorite}
            onClick={onToggleFavorite}
          >
            <Star className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </ToolButton>

          <span className="stage-toolbar-divider" aria-hidden="true" />

          <CaptureInfoButton capture={selectedCapture} contextBadge={contextBadge} onCopyPath={onCopyPath} />
          <ToolButton
            label={hasCompareAnchor ? "Clear compare" : "Compare with another capture"}
            active={hasCompareAnchor}
            onClick={hasCompareAnchor ? onClearCompareAnchor : onSetCompareAnchor}
          >
            <Layers3 className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Redact capture" onClick={onRedactCapture}>
            <Shield className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </ToolButton>
          <ToolButton label="Quick Look (Space)" onClick={() => onOpenQuickLook(imageRef.current)}>
            <Expand className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </ToolButton>

          <span className="stage-toolbar-divider" aria-hidden="true" />

          <ToolButton label="Delete capture (Delete)" tone="danger" onClick={onDeleteCapture}>
            <Trash2 className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
          </ToolButton>
        </div>
      </div>
    </main>
  );
}

export function captureAspectRatio(capture: CaptureRecord): number {
  return capture.width > 0 && capture.height > 0 ? capture.width / capture.height : 16 / 9;
}

function StageWarning({ message }: { message: string }) {
  return (
    <p className="stage-warning" role="status">
      <AlertTriangle className="lucide-icon" size={14} strokeWidth={2} aria-hidden="true" />
      {message}
    </p>
  );
}

type ToolButtonProps = {
  active?: boolean;
  children: React.ReactNode;
  label: string;
  tone?: "danger";
  onClick: () => void;
};

function ToolButton({ active = false, children, label, tone, onClick }: ToolButtonProps) {
  return (
    <button
      className={["tool-button", active ? "active" : "", tone === "danger" ? "tool-button-danger" : ""].join(" ").trim()}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={tone === "danger" ? undefined : active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type CaptureInfoButtonProps = {
  capture: CaptureRecord;
  contextBadge: string;
  onCopyPath: () => void;
};

function CaptureInfoButton({ capture, contextBadge, onCopyPath }: CaptureInfoButtonProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  useDismiss(containerRef, isOpen, close);

  const reviewState =
    [capture.isBookmarked ? "Bookmarked" : "", capture.isFavorite ? "Favorite" : "", capture.tags.length > 0 ? `${capture.tags.length} tag(s)` : ""]
      .filter(Boolean)
      .join(", ") || "Unmarked";

  return (
    <div ref={containerRef} className="menu-anchor">
      <ToolButton label="Capture info" active={isOpen} onClick={() => setIsOpen((current) => !current)}>
        <Info className="lucide-icon" size={ICON_SIZE - 1} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
      </ToolButton>

      {isOpen ? (
        <div className="info-popover popover" role="dialog" aria-label="Capture details">
          <p className="popover-label">Capture details</p>
          <dl className="detail-list">
            <div>
              <dt>Captured</dt>
              <dd>
                {formatViewerDate(capture.dayKey)} · {formatCaptureTimestamp(capture.capturedAt)}
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {capture.width} × {capture.height}
              </dd>
            </div>
            <div>
              <dt>Context</dt>
              <dd>{contextBadge}</dd>
            </div>
            <div>
              <dt>Review</dt>
              <dd>{reviewState}</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd className="detail-mono">{capture.imagePath}</dd>
            </div>
          </dl>
          <button
            className="button button-small"
            type="button"
            onClick={() => {
              onCopyPath();
              setIsOpen(false);
            }}
          >
            <Copy className="lucide-icon" size={13} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
            Copy File Path
          </button>
        </div>
      ) : null}
    </div>
  );
}
