import type { CaptureRecord, DaySummary, SettingsPayload, StorageStatsPayload, CaptureHealthPayload,
  PerformanceSnapshotPayload, OcrHealthPayload, RecordingStatePayload, ReviewShortcutsPayload } from "../types";

type Invoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type RefreshScope = "status" | "review" | "all";
export type RefreshContext = {
  owner: { current(): number };
  libraryRevision: number;
  updateRevision: number;
  dayKey: string;
};
export type ArchiveSnapshot = {
  status?: { settings: SettingsPayload; stats: StorageStatsPayload; health: CaptureHealthPayload;
    performance: PerformanceSnapshotPayload; ocr: OcrHealthPayload; recording: RecordingStatePayload };
  review?: ReviewShortcutsPayload;
  storagePath?: string;
  day?: { summaries: DaySummary[]; dayKey: string; captures: CaptureRecord[]; startOffset: number };
};
export type RefreshOutcome = {
  status: "ready" | "busy" | "error" | "superseded";
  context: RefreshContext;
  snapshot?: ArchiveSnapshot;
  error?: string;
};
const masks = { status: 1, review: 2, all: 7 };
const sameContext = (a: RefreshContext, b: RefreshContext) => a.owner === b.owner
  && a.libraryRevision === b.libraryRevision && a.updateRevision === b.updateRevision && a.dayKey === b.dayKey;

// Drain admitted siblings before retrying: Promise.all's early rejection would leave
// those native jobs alive while the next batch consumes still more permits.
async function settled<T extends unknown[]>(promises: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as T;
}

export class ArchiveRefreshService {
  private version = 0;
  private flight: Promise<RefreshOutcome> | null = null;
  private active: { context: RefreshContext; mask: number } | null = null;
  private pending: { context: RefreshContext; mask: number } | null = null;
  private latest: RefreshContext | null = null;

  constructor(private invoke: Invoker, private pageLimit: number,
    private delay: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {}

  invalidate() { return ++this.version; }
  currentRevision() { return this.version; }
  isCurrent(context: RefreshContext) {
    return this.latest !== null && sameContext(context, this.latest)
      && context.updateRevision === this.version && context.owner.current() === context.libraryRevision;
  }

  request(context: RefreshContext, scope: RefreshScope): Promise<RefreshOutcome> {
    const mask = masks[scope];
    // Status/review refreshes must not undo a full refresh's requested day.
    if (scope !== "all" && this.latest?.owner === context.owner && (((this.active?.mask ?? 0) | (this.pending?.mask ?? 0)) & 4) !== 0) {
      context = { ...context, dayKey: this.latest.dayKey };
    }
    this.latest = context;
    if (this.flight) {
      const existing = this.pending ?? this.active!;
      if (!sameContext(existing.context, context) || (mask & existing.mask) !== mask) {
        // A single replaceable follow-up, never a per-caller queue.
        this.pending = { context, mask: mask | existing.mask | this.active!.mask };
      }
      return this.flight;
    }
    this.active = { context, mask };
    this.flight = this.drain();
    return this.flight;
  }

  private async drain(): Promise<RefreshOutcome> {
    for (;;) {
      const job = this.active!;
      let outcome: RefreshOutcome = { status: "superseded", context: job.context };
      // Three attempts at most for one version. New invalidations replace one follow-up.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const snapshot = await this.load(job.mask, job.context);
          outcome = { status: this.isCurrent(job.context) ? "ready" : "superseded", context: job.context, snapshot };
          break;
        } catch (error) {
          const message = String(error);
          const busy = message.includes("Archive is busy.");
          outcome = { status: busy ? "busy" : "error", context: job.context, error: message };
          if (!busy || attempt === 2 || !this.isCurrent(job.context)) break;
          await this.delay(attempt === 0 ? 100 : 250);
        }
      }
      if (!this.pending) { this.flight = null; this.active = null; return outcome; }
      this.active = this.pending; this.pending = null;
    }
  }

  private async load(mask: number, context: RefreshContext): Promise<ArchiveSnapshot> {
    const status = async () => {
      const [settings, stats] = await settled([
        this.invoke<SettingsPayload>("get_settings"), this.invoke<StorageStatsPayload>("get_storage_stats"),
      ]);
      const [health, performance, recording] = await settled([
        this.invoke<CaptureHealthPayload>("get_capture_health"), this.invoke<PerformanceSnapshotPayload>("get_performance_snapshot"),
        this.invoke<RecordingStatePayload>("get_recording_state"),
      ]);
      const ocr = await this.invoke<OcrHealthPayload>("get_ocr_health");
      return { settings, stats, health, performance, recording, ocr };
    };
    // At most three general native commands in this metadata stage (two status + review).
    const [statusData, review, storagePath] = await settled([
      mask & 1 ? status() : Promise.resolve(undefined),
      mask & 2 ? this.invoke<ReviewShortcutsPayload>("get_review_shortcuts", { limit: 12 }) : Promise.resolve(undefined),
      mask & 4 ? this.invoke<string>("get_storage_path") : Promise.resolve(undefined),
    ]);
    const snapshot: ArchiveSnapshot = { status: statusData, review, storagePath };
    if ((mask & 4) && this.isCurrent(context)) {
      const summaries = await this.invoke<DaySummary[]>("get_day_summaries");
      if (!this.isCurrent(context)) return snapshot;
      const total = summaries.find((day) => day.dayKey === context.dayKey)?.captureCount ?? 0;
      const startOffset = Math.max(0, total - this.pageLimit);
      const captures = total > 0 ? await this.invoke<CaptureRecord[]>("get_day_captures", {
        dayKey: context.dayKey, offset: startOffset, limit: total - startOffset,
      }) : [];
      snapshot.day = { summaries, dayKey: context.dayKey, captures, startOffset };
    }
    return snapshot;
  }
}
