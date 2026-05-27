import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CaptureRecord, PerformanceSnapshotPayload, RetrievalSearchResult } from "../types";
import { buildCaptureSearchText } from "../utils/app";

type UseArchiveSearchOptions = {
  captures: CaptureRecord[];
  onPerformanceSnapshot: (snapshot: PerformanceSnapshotPayload) => void;
};

export function useArchiveSearch({ captures, onPerformanceSnapshot }: UseArchiveSearchOptions) {
  const [captureSearchQuery, setCaptureSearchQuery] = useState<string>("");
  const [retrievalResults, setRetrievalResults] = useState<RetrievalSearchResult[]>([]);
  const [isRetrievalLoading, setIsRetrievalLoading] = useState<boolean>(false);
  const [retrievalError, setRetrievalError] = useState<string | null>(null);
  const [activeRetrievalResultIndex, setActiveRetrievalResultIndex] = useState<number>(-1);

  const normalizedSearch = captureSearchQuery.trim().toLowerCase();
  const deferredNormalizedSearch = useDeferredValue(normalizedSearch);
  const captureSearchTextById = useMemo(
    () => new Map(captures.map((capture) => [capture.id, buildCaptureSearchText(capture)])),
    [captures],
  );
  const retrievalResultIdSet = useMemo(
    () => new Set(retrievalResults.map((result) => result.captureId)),
    [retrievalResults],
  );

  const filteredCaptures = useMemo(() => {
    if (deferredNormalizedSearch.length === 0) {
      return captures;
    }

    if (retrievalResults.length > 0) {
      return captures.filter((capture) => retrievalResultIdSet.has(capture.id));
    }

    return captures.filter((capture) =>
      (captureSearchTextById.get(capture.id) ?? "").includes(deferredNormalizedSearch),
    );
  }, [captureSearchTextById, captures, deferredNormalizedSearch, retrievalResultIdSet, retrievalResults.length]);

  useEffect(() => {
    let disposed = false;
    const query = captureSearchQuery.trim();

    if (query.length < 2) {
      setRetrievalResults([]);
      setRetrievalError(null);
      setIsRetrievalLoading(false);
      setActiveRetrievalResultIndex(-1);
      return () => {
        disposed = true;
      };
    }

    setIsRetrievalLoading(true);
    setRetrievalError(null);
    setRetrievalResults([]);
    setActiveRetrievalResultIndex(-1);

    const timeoutId = window.setTimeout(() => {
      const loadResults = async () => {
        try {
          const results = await invoke<RetrievalSearchResult[]>("search_captures", {
            query,
            limit: 20,
          });

          if (!disposed) {
            setRetrievalResults(results);
            setActiveRetrievalResultIndex(results.length > 0 ? 0 : -1);
          }
        } catch {
          if (!disposed) {
            setRetrievalError("Archive search unavailable right now.");
          }
        } finally {
          if (!disposed) {
            setIsRetrievalLoading(false);
          }

          try {
            const snapshot = await invoke<PerformanceSnapshotPayload>("get_performance_snapshot");
            if (!disposed) {
              onPerformanceSnapshot(snapshot);
            }
          } catch {
            // Ignore snapshot refresh errors.
          }
        }
      };

      void loadResults();
    }, 180);

    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
    };
  }, [captureSearchQuery, onPerformanceSnapshot]);

  return {
    activeRetrievalResultIndex,
    captureSearchQuery,
    filteredCaptures,
    isRetrievalLoading,
    normalizedSearch,
    retrievalError,
    retrievalResults,
    setActiveRetrievalResultIndex,
    setCaptureSearchQuery,
  };
}
