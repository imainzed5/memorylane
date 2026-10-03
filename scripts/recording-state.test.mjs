import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/utils/recordingState.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { acceptRecordingState } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const state = (revision, options = {}) => ({ revision, generation: 1, intervalMinutes: 2, isMaintaining: false, isPaused: false, isCapturing: false,
  nextScheduledAttemptAt: 1000, lastAttemptAt: null, queuedManualCaptures: 0, ...options });

test("a late active-attempt read cannot overwrite its completion event", () => {
  const finished = state(3, { lastAttemptAt: 500, nextScheduledAttemptAt: 1500 });
  const lateRead = state(2, { isCapturing: true });
  assert.equal(acceptRecordingState(finished, lateRead), finished);
});

test("a late recording event cannot undo a paused imported library", () => {
  const restored = state(10, { generation: 3, isPaused: true, nextScheduledAttemptAt: null });
  assert.equal(acceptRecordingState(restored, state(9)), restored);
  const resumed = state(11, { generation: 4, nextScheduledAttemptAt: 2000 });
  assert.equal(acceptRecordingState(restored, resumed), resumed);
  assert.equal(acceptRecordingState(null, restored), restored);
});
