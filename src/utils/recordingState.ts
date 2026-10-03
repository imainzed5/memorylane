import type { RecordingStatePayload } from "../types";

// Events and command responses can arrive out of order, even within one privacy generation.
export function acceptRecordingState(current: RecordingStatePayload | null, incoming: RecordingStatePayload) {
  return !current || incoming.revision >= current.revision ? incoming : current;
}
