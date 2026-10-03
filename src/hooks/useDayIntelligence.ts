import { useCallback, useEffect, useState } from "react";
import type { ContentRevision } from "../utils/contentRevision";
import { invoke } from "@tauri-apps/api/core";
import type { DayIntelligencePayload, PerformanceSnapshotPayload } from "../types";
import { isDayKey } from "../utils/app";

type UseDayIntelligenceOptions = {
  contentRevision: ContentRevision;
  libraryRevision: number;
  captureCount: number;
  dayKey: string;
  onPerformanceSnapshot: (snapshot: PerformanceSnapshotPayload) => void;
};

export function useDayIntelligence({ captureCount, dayKey, contentRevision, libraryRevision, onPerformanceSnapshot }: UseDayIntelligenceOptions) {
  const [dayIntelligence, setDayIntelligence] = useState<DayIntelligencePayload | null>(null);
  const [isDayIntelligenceLoading, setIsDayIntelligenceLoading] = useState<boolean>(false);
  const [dayIntelligenceError, setDayIntelligenceError] = useState<string | null>(null);

  const invalidateIntelligence = useCallback(() => {
    setDayIntelligence(null);
    setDayIntelligenceError(null);
    setIsDayIntelligenceLoading(false);
  }, []);

  useEffect(() => {
    let disposed = false;
    const revision = contentRevision.current();

    if (!isDayKey(dayKey)) {
      setDayIntelligence(null);
      setDayIntelligenceError(null);
      setIsDayIntelligenceLoading(false);
      return () => {
        disposed = true;
      };
    }

    setDayIntelligence(null);
    setIsDayIntelligenceLoading(true);
    setDayIntelligenceError(null);

    const timeoutId = window.setTimeout(() => {
      const loadDayIntelligence = async () => {
        try {
          const payload = await invoke<DayIntelligencePayload>("get_day_intelligence", {
            dayKey,
          });

          if (!disposed && contentRevision.isCurrent(revision)) {
            setDayIntelligence(payload);
          }
        } catch {
          if (!disposed && contentRevision.isCurrent(revision)) {
            setDayIntelligenceError("Day summary unavailable right now.");
          }
        } finally {
          if (!disposed && contentRevision.isCurrent(revision)) {
            setIsDayIntelligenceLoading(false);
          }
        }

        try {
          const snapshot = await invoke<PerformanceSnapshotPayload>("get_performance_snapshot");
          if (!disposed && contentRevision.isCurrent(revision)) {
            onPerformanceSnapshot(snapshot);
          }
        } catch {
          // Ignore snapshot refresh errors.
        }
      };

      void loadDayIntelligence();
    }, 140);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [captureCount, dayKey, contentRevision, libraryRevision, onPerformanceSnapshot]);

  return {
    invalidateIntelligence,
    dayIntelligence,
    dayIntelligenceError,
    isDayIntelligenceLoading,
  };
}
