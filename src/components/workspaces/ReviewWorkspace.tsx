import { Bookmark, Layers3, Shield, Star } from "lucide-react";
import type { CaptureRecord, NoteSaveState, ReviewShortcutCapture, ReviewShortcutsPayload } from "../../types";
import { ICON_STROKE_WIDTH } from "../../constants";
import { formatViewerDate } from "../../utils/app";
import { useContextMenu, type CaptureMenuBuilder } from "../ContextMenu";
import { WorkspaceHeader } from "../primitives";

type ReviewWorkspaceProps = {
  buildCaptureMenu: CaptureMenuBuilder;
  compareCaptureLabel: string | null;
  isReviewBusy: boolean;
  noteDirty: boolean;
  noteDraft: string;
  noteSaveState: NoteSaveState;
  reviewShortcuts: ReviewShortcutsPayload;
  selectedCapture: CaptureRecord | null;
  selectedDayLabel: string;
  tagDraft: string;
  onApplyTagFilter: (tag: string) => void;
  onClearCompareAnchor: () => void;
  onJumpToReviewCapture: (captureId: number) => void;
  onNoteDraftChange: (nextValue: string) => void;
  onRedactCapture: () => void;
  onSaveNote: () => void;
  onSaveTags: () => void;
  onSetCompareAnchor: () => void;
  onTagDraftChange: (nextValue: string) => void;
  onToggleBookmark: () => void;
  onToggleFavorite: () => void;
};

export function ReviewWorkspace({
  buildCaptureMenu,
  compareCaptureLabel,
  isReviewBusy,
  noteDirty,
  noteDraft,
  noteSaveState,
  reviewShortcuts,
  selectedCapture,
  selectedDayLabel,
  tagDraft,
  onApplyTagFilter,
  onClearCompareAnchor,
  onJumpToReviewCapture,
  onNoteDraftChange,
  onRedactCapture,
  onSaveNote,
  onSaveTags,
  onSetCompareAnchor,
  onTagDraftChange,
  onToggleBookmark,
  onToggleFavorite,
}: ReviewWorkspaceProps) {
  const openContextMenu = useContextMenu();
  const noteStatus =
    noteSaveState === "saving"
      ? "Saving…"
      : noteSaveState === "saved"
        ? "Saved"
        : noteSaveState === "error"
          ? "Couldn't save"
          : noteDirty
            ? "Unsaved changes"
            : null;
  const isDisabled = !selectedCapture || isReviewBusy;

  return (
    <main className="workspace review-workspace" data-workspace-pane>
      <WorkspaceHeader title="Review" subtitle={`Bookmark, tag, annotate and compare moments from ${selectedDayLabel}.`} />

      <div className="workspace-body workspace-scroll">
        <div className="review-grid">
          <section className="card review-current">
            <div className="card-head">
              <div>
                <h3>Current capture</h3>
                <p className="card-subtitle">
                  {selectedCapture
                    ? `${selectedCapture.timestampLabel} · ${selectedCapture.processName.trim() || "Unknown app"}`
                    : "Select a capture from the timeline below."}
                </p>
              </div>
              {selectedCapture ? (
                <img
                  className="review-thumb"
                  src={selectedCapture.thumbnailDataUrl}
                  alt=""
                  draggable={false}
                  onContextMenu={(event) =>
                    openContextMenu(
                      event,
                      buildCaptureMenu(selectedCapture, { surface: "review", source: event.currentTarget }),
                      `Capture at ${selectedCapture.timestampLabel}`,
                    )
                  }
                />
              ) : null}
            </div>

            <div className="review-actions">
              <button
                className={selectedCapture?.isBookmarked ? "button button-toggle active" : "button button-toggle"}
                type="button"
                aria-pressed={Boolean(selectedCapture?.isBookmarked)}
                onClick={onToggleBookmark}
                disabled={isDisabled}
              >
                <Bookmark className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                {selectedCapture?.isBookmarked ? "Bookmarked" : "Bookmark"}
              </button>
              <button
                className={selectedCapture?.isFavorite ? "button button-toggle active" : "button button-toggle"}
                type="button"
                aria-pressed={Boolean(selectedCapture?.isFavorite)}
                onClick={onToggleFavorite}
                disabled={isDisabled}
              >
                <Star className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                {selectedCapture?.isFavorite ? "Favorited" : "Favorite"}
              </button>
              <button
                className={compareCaptureLabel ? "button button-toggle active" : "button button-toggle"}
                type="button"
                aria-pressed={Boolean(compareCaptureLabel)}
                onClick={compareCaptureLabel ? onClearCompareAnchor : onSetCompareAnchor}
                disabled={compareCaptureLabel ? isReviewBusy : isDisabled}
                title={compareCaptureLabel ? `Comparing with ${compareCaptureLabel}` : "Use this capture as the compare anchor"}
              >
                <Layers3 className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                {compareCaptureLabel ? "Clear Compare" : "Set Compare"}
              </button>
              <button className="button" type="button" onClick={onRedactCapture} disabled={isDisabled}>
                <Shield className="lucide-icon" size={14} strokeWidth={ICON_STROKE_WIDTH} aria-hidden="true" />
                Redact
              </button>
            </div>

            <label className="field" htmlFor="review-note-input">
              <span className="field-label">
                Note
                {noteStatus ? <span className={noteSaveState === "error" ? "field-status warning" : "field-status"}>{noteStatus}</span> : null}
              </span>
              <textarea
                id="review-note-input"
                value={noteDraft}
                placeholder={selectedCapture ? "What was happening here?" : "Select a capture to write a note"}
                disabled={!selectedCapture}
                onChange={(event) => onNoteDraftChange(event.currentTarget.value)}
                onBlur={() => {
                  if (noteDirty) {
                    onSaveNote();
                  }
                }}
              />
            </label>
            <div className="card-actions">
              <button className="button button-accent" type="button" onClick={onSaveNote} disabled={!selectedCapture || !noteDirty}>
                Save Note
              </button>
            </div>
          </section>

          <section className="card review-tags">
            <h3>Tags</h3>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                onSaveTags();
              }}
            >
              <input
                id="review-capture-tags-input"
                type="text"
                value={tagDraft}
                placeholder="roadmap, launch, meeting"
                aria-label="Capture tags, separated by commas"
                disabled={!selectedCapture}
                onChange={(event) => onTagDraftChange(event.currentTarget.value)}
              />
              <button className="button" type="submit" disabled={isDisabled}>
                Save
              </button>
            </form>

            {selectedCapture?.tags.length ? (
              <div className="tag-row">
                {selectedCapture.tags.map((tag) => (
                  <button key={`selected-${tag}`} className="tag tag-button" type="button" onClick={() => onApplyTagFilter(tag)}>
                    #{tag}
                  </button>
                ))}
              </div>
            ) : (
              <p className="card-subtitle">No tags on this capture yet.</p>
            )}

            {reviewShortcuts.tags.length > 0 ? (
              <>
                <p className="section-label">Popular tags</p>
                <div className="tag-row">
                  {reviewShortcuts.tags.slice(0, 12).map((tag) => (
                    <button key={`popular-${tag.tag}`} className="tag tag-button tag-quiet" type="button" onClick={() => onApplyTagFilter(tag.tag)}>
                      #{tag.tag} <span>{tag.captureCount}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </section>

          <section className="card review-saved">
            <h3>Saved moments</h3>
            <div className="saved-columns">
              <SavedList title="Bookmarks" emptyLabel="No bookmarks yet. Press B on any capture." items={reviewShortcuts.bookmarks} onJump={onJumpToReviewCapture} />
              <SavedList title="Favorites" emptyLabel="No favorites yet. Press F on any capture." items={reviewShortcuts.favorites} onJump={onJumpToReviewCapture} />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

type SavedListProps = {
  emptyLabel: string;
  items: ReviewShortcutCapture[];
  title: string;
  onJump: (captureId: number) => void;
};

function SavedList({ emptyLabel, items, title, onJump }: SavedListProps) {
  return (
    <div className="saved-list">
      <p className="section-label">{title}</p>
      {items.length === 0 ? (
        <p className="card-subtitle">{emptyLabel}</p>
      ) : (
        <ul>
          {items.slice(0, 10).map((item) => (
            <li key={item.captureId}>
              <button className="list-row" type="button" onClick={() => onJump(item.captureId)}>
                <span>{formatViewerDate(item.dayKey)}</span>
                <strong>{item.timestampLabel}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
