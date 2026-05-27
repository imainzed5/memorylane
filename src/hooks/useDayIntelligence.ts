import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DayIntelligencePayload, PerformanceSnapshotPayload } from "../types";
import { isDayKey } from "../utils/app";

type UseDayIntelligenceOptions = {
  captureCount: number;
  dayKey: string;
  onPerformanceSnapshot: (snapshot: PerformanceSnapshotPayload) => void;
};

export function useDayIntelligence({ captureCount, dayKey, onPerformanceSnapshot }: UseDayIntelligenceOptions) {
  const [dayIntelligence, setDayIntelligence] = useState<DayIntelligencePayload | null>(null);
  const [isDayIntelligenceLoading, setIsDayIntelligenceLoading] = useState<boolean>(false);
  const [dayIntelligenceError, setDayIntelligenceError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;

    if (!isDayKey(dayKey)) {
      setDayIntelligence(null);
      setDayIntelligenceError(null);
      setIsDayIntelligenceLoading(false);
      return () => {
        disposed = true;
      };
    }

    setIsDayIntelligenceLoading(true);
    setDayIntelligenceError(null);

    const timeoutId = window.setTimeout(() => {
      const loadDayIntelligence = async () => {
        try {
          const payload = await invoke<DayIntelligencePayload>("get_day_intelligence", {
            dayKey,
          });

          if (!disposed) {
            setDayIntelligence(payload);
          }
        } catch {
          if (!disposed) {
            setDayIntelligenceError("Day summary unavailable right now.");
          }
        } finally {
          if (!disposed) {
            setIsDayIntelligenceLoading(false);
          }
        }

        try {
          const snapshot = await invoke<PerformanceSnapshotPayload>("get_performance_snapshot");
          if (!disposed) {
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
  }, [captureCount, dayKey, onPerformanceSnapshot]);

  return {
    dayIntelligence,
    dayIntelligenceError,
    isDayIntelligenceLoading,
  };
}
