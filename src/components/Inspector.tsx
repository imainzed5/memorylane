import { Camera, Pause, Play } from "lucide-react";
import type { CaptureRecord, StorageStatsPayload } from "../types";
import { formatStorageValue, formatViewerDate } from "../utils/app";

type InspectorProps = {
  intervalMinutes: number;
  isOpen: boolean;
  isRecording: boolean;
  nextCaptureLabel: string;
  selectedCapture: CaptureRecord | null;
  storageStats: StorageStatsPayload;
  todayCaptureCount: number;
  onApplyTagFilter: (tag: string) => void;
  onCaptureNow: () => void;
  onOpenReview: () => void;
  onTogglePause: () => void;
};

export function Inspector({
  intervalMinutes,
  isOpen,
  isRecording,
  nextCaptureLabel,
  selectedCapture,
  storageStats,
  todayCaptureCount,
  onApplyTagFilter,
  onCaptureNow,
  onOpenReview,
  onTogglePause,
}: InspectorProps) {
  const usagePercent = Math.max(0, Math.min(100, storageStats.usagePercent));

  return (
    <aside className="inspector" aria-label="Inspector" aria-hidden={!isOpen} inert={!isOpen}>
      <div className="inspector-scroll">
        <section className="inspector-section">
          <p className="inspector-heading">Capture</p>
          {selectedCapture ? (
            <>
              <div className="inspector-hero">
                <strong>{selectedCapture.timestampLabel}</strong>
                <span>{formatViewerDate(selectedCapture.dayKey)}</span>
              </div>
              <dl className="detail-list">
                <div>
                  <dt>App</dt>
                  <dd>{selectedCapture.processName.trim() || "Unknown"}</dd>
                </div>
                {selectedCapture.windowTitle.trim() ? (
                  <div>
                    <dt>Window</dt>
                    <dd className="detail-clamp">{selectedCapture.windowTitle}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Size</dt>
                  <dd>
                    {selectedCapture.width} × {selectedCapture.height}
                  </dd>
                </div>
              </dl>

              {selectedCapture.tags.length > 0 ? (
                <div className="tag-row">
                  {selectedCapture.tags.map((tag) => (
                    <button key={tag} className="tag tag-button" type="button" onClick={() => onApplyTagFilter(tag)}>
                      #{tag}
                    </button>
                  ))}
                </div>
              ) : null}

              {selectedCapture.captureNote.trim() ? (
                <p className="inspector-note">{selectedCapture.captureNote}</p>
              ) : null}

              <button className="button button-small button-plain inspector-link" type="button" onClick={onOpenReview}>
                {selectedCapture.captureNote.trim() || selectedCapture.tags.length > 0 ? "Edit Note & Tags" : "Add Note or Tags"}
              </button>
            </>
          ) : (
            <p className="inspector-muted">No capture selected.</p>
          )}
        </section>

        <section className="inspector-section">
          <p className="inspector-heading">Recording</p>
          <div className="recording-status">
            <span className={isRecording ? "recording-dot is-live" : "recording-dot"} aria-hidden="true" />
            <div>
              <strong>{isRecording ? "Recording" : "Paused"}</strong>
              <span>
                {isRecording ? nextCaptureLabel : "Captures are paused"} · every {intervalMinutes} min
              </span>
            </div>
          </div>
          <p className="inspector-muted">
            {todayCaptureCount} capture{todayCaptureCount === 1 ? "" : "s"} today
          </p>
          <div className="inspector-actions">
            <button className="button" type="button" onClick={onTogglePause} title="Pause or resume (P)">
              {isRecording ? (
                <Pause className="lucide-icon" size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Play className="lucide-icon" size={13} strokeWidth={2} aria-hidden="true" />
              )}
              {isRecording ? "Pause" : "Resume"}
            </button>
            <button className="button button-accent" type="button" onClick={onCaptureNow} title="Capture now (C)">
              <Camera className="lucide-icon" size={13} strokeWidth={2} aria-hidden="true" />
              Capture Now
            </button>
          </div>
        </section>

        <section className="inspector-section">
          <p className="inspector-heading">Storage</p>
          <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(usagePercent)} aria-label="Storage used">
            <span style={{ width: `${usagePercent}%` }} />
          </div>
          <p className="inspector-muted">
            {formatStorageValue(storageStats.usedGb)} of {storageStats.storageCapGb.toFixed(1)} GB · {storageStats.captureCount} captures
          </p>
        </section>
      </div>
    </aside>
  );
}
