import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../src/utils/archiveRefresh.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { ArchiveRefreshService } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const immediate = new Set(["get_recording_state", "get_storage_path", "get_capture_health", "get_performance_snapshot"]);
const value = (command, version) => command === "get_day_summaries" ? [{ dayKey: "2026-10-03", captureCount: 1 }]
  : command === "get_day_captures" ? [{ id: 1, version }] : { version };
const context = (service, owner) => ({ owner, libraryRevision: owner.current(), updateRevision: service.currentRevision(), dayKey: "2026-10-03" });

test("StrictMode startup and event/direct refreshes share one flight and drain stalled siblings before retry", async () => {
  let revision = 0, version = 0, active = 6, peak = active, delays = 0;
  const owner = { current: () => revision }, gate = deferred(), calls = [], unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const invoke = async command => {
    calls.push(command);
    if (immediate.has(command)) return value(command, version);
    if (active >= 8) throw new Error("Archive is busy. Wait for the current operation and try again.");
    active++; peak = Math.max(peak, active);
    const capturedVersion = version;
    try { await gate.promise; return value(command, capturedVersion); } finally { active--; }
  };
  const service = new ArchiveRefreshService(invoke, 240, async () => { delays++; });
  try {
    const startup = service.request(context(service, owner), "all");
    assert.equal(service.request(context(service, owner), "all"), startup, "StrictMode shares startup");
    await tick();
    assert.equal(delays, 0, "busy rejection must wait for admitted siblings");
    revision++; version++; service.invalidate();
    const event = service.request(context(service, owner), "all");
    const direct = service.request(context(service, owner), "all");
    assert.equal(event, direct);
    assert.equal(event, startup);
    // A second invalidation replaces the pending job, rather than appending a batch.
    revision++; version++; service.invalidate();
    service.request(context(service, owner), "all");
    active -= 6; gate.resolve();
    const result = await direct;
    assert.equal(result.status, "ready");
    assert.equal(result.context.libraryRevision, 2);
    assert.equal(result.snapshot.day.captures[0].version, 2, "reused IDs expose only current content");
    assert.equal(calls.filter(c => c === "get_settings").length, 2, "one startup and one latest follow-up");
    assert.equal(calls.filter(c => c === "get_day_captures").length, 1);
    assert.ok(peak <= 8);
    await tick(); assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", onUnhandled); }
});

test("persistent contention is bounded and does not turn a completed capture into a rejected refresh", async () => {
  const owner = { current: () => 0 }; let settingsCalls = 0, delays = 0, saved = false;
  const invoke = async command => {
    if (command === "capture_now") { saved = true; return; }
    if (command === "get_settings") settingsCalls++;
    if (!immediate.has(command)) throw new Error("Archive is busy.");
    return {};
  };
  const service = new ArchiveRefreshService(invoke, 240, async () => { delays++; });
  await invoke("capture_now");
  const event = service.request(context(service, owner), "all");
  const direct = service.request(context(service, owner), "all");
  assert.equal(event, direct);
  const result = await direct;
  assert.equal(saved, true);
  assert.equal(result.status, "busy");
  assert.equal(settingsCalls, 3);
  assert.equal(delays, 2);
});

test("ordinary capture invalidation refreshes the latest data without changing library revision", async () => {
  const owner = { current: () => 0 }, gate = deferred(); let version = 0, settingsCalls = 0;
  const service = new ArchiveRefreshService(async command => {
    if (command === "get_settings") { settingsCalls++; await gate.promise; }
    return value(command, version);
  }, 240);
  const initial = service.request(context(service, owner), "all");
  service.invalidate(); version = 1;
  service.request(context(service, owner), "all");
  gate.resolve();
  const result = await initial;
  assert.equal(result.status, "ready");
  assert.equal(result.snapshot.day.captures[0].version, 1);
  assert.equal(settingsCalls, 2);
});
