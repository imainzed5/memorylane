import type { DayFocusBlock, DayIntelligencePayload, DaySummary } from "../../types";
import { WorkspaceHeader } from "../primitives";

type IntelligenceWorkspaceProps = {
  dayIntelligence: DayIntelligencePayload | null;
  dayIntelligenceError: string | null;
  dayIntelligenceLoading: boolean;
  selectedDayLabel: string;
  selectedDaySummary: DaySummary;
  onSearchForTerm: (term: string) => void;
};

const FOCUS_PREVIEW_COUNT = 8;
const HIGHLIGHT_PREVIEW_COUNT = 10;

export function IntelligenceWorkspace({
  dayIntelligence,
  dayIntelligenceError,
  dayIntelligenceLoading,
  selectedDayLabel,
  selectedDaySummary,
  onSearchForTerm,
}: IntelligenceWorkspaceProps) {
  const isReady = !dayIntelligenceLoading && !dayIntelligenceError && dayIntelligence !== null;
  const focusBlocks = dayIntelligence?.focusBlocks ?? [];
  const highlights = dayIntelligence?.changeHighlights ?? [];
  const topThemes = dayIntelligence?.topTerms ?? [];

  return (
    <main className="workspace intelligence-workspace" data-workspace-pane>
      <WorkspaceHeader title="Intelligence" subtitle={`An on-device summary of ${selectedDayLabel}. Nothing leaves your computer.`} />

      <div className="workspace-body workspace-scroll">
        <section className="card">
          <div className="card-head">
            <h3>Overview</h3>
            <span className="tag tag-quiet">{selectedDaySummary.captureCount} captures</span>
          </div>

          {dayIntelligenceLoading ? <p className="card-subtitle">Summarizing this day…</p> : null}
          {dayIntelligenceError ? <p className="inline-warning">{dayIntelligenceError}</p> : null}
          {!dayIntelligenceLoading && !dayIntelligenceError && !dayIntelligence ? (
            <p className="card-subtitle">No summary available for this day yet.</p>
          ) : null}

          {isReady && dayIntelligence ? (
            <>
              <p className="intelligence-summary">{dayIntelligence.summary}</p>
              <div className="stat-grid">
                <Stat label="Sessions" value={focusBlocks.length} />
                <Stat label="Context changes" value={highlights.length} />
                <Stat label="Themes" value={topThemes.length} />
              </div>
              {topThemes.length > 0 ? (
                <>
                  <p className="section-label">Top themes · select one to search</p>
                  <div className="tag-row">
                    {topThemes.map((term) => (
                      <button key={term} className="tag tag-button" type="button" onClick={() => onSearchForTerm(term)}>
                        {term}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              <p className="card-footnote">
                Generated in {dayIntelligence.generationMs} ms at {dayIntelligence.generatedAt}
              </p>
            </>
          ) : null}
        </section>

        {isReady ? (
          <>
            <section className="card">
              <div className="card-head">
                <h3>Focus sessions</h3>
                <span className="tag tag-quiet">{focusBlocks.length}</span>
              </div>
              {focusBlocks.length > 0 ? (
                <>
                  <SessionGrid blocks={focusBlocks.slice(0, FOCUS_PREVIEW_COUNT)} />
                  {focusBlocks.length > FOCUS_PREVIEW_COUNT ? (
                    <details className="disclosure">
                      <summary>Show {focusBlocks.length - FOCUS_PREVIEW_COUNT} more</summary>
                      <SessionGrid blocks={focusBlocks.slice(FOCUS_PREVIEW_COUNT)} />
                    </details>
                  ) : null}
                </>
              ) : (
                <p className="card-subtitle">Sessions appear here as captures accumulate.</p>
              )}
            </section>

            <section className="card">
              <h3>What changed</h3>
              {highlights.length > 0 ? (
                <>
                  <ul className="highlight-list">
                    {highlights.slice(0, HIGHLIGHT_PREVIEW_COUNT).map((highlight, index) => (
                      <li key={`${index}-${highlight}`}>{highlight}</li>
                    ))}
                  </ul>
                  {highlights.length > HIGHLIGHT_PREVIEW_COUNT ? (
                    <details className="disclosure">
                      <summary>Show {highlights.length - HIGHLIGHT_PREVIEW_COUNT} more</summary>
                      <ul className="highlight-list">
                        {highlights.slice(HIGHLIGHT_PREVIEW_COUNT).map((highlight, index) => (
                          <li key={`more-${index}-${highlight}`}>{highlight}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </>
              ) : (
                <p className="card-subtitle">No major context shifts detected.</p>
              )}
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SessionGrid({ blocks }: { blocks: DayFocusBlock[] }) {
  return (
    <div className="session-grid">
      {blocks.map((block) => (
        <article key={`${block.startTimestampLabel}-${block.endTimestampLabel}`} className="session">
          <strong>
            {block.startTimestampLabel} – {block.endTimestampLabel}
          </strong>
          <span>{block.captureCount} captures</span>
          <p>{block.dominantContext}</p>
        </article>
      ))}
    </div>
  );
}
