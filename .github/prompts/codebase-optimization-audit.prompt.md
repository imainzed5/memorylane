---
description: "Audit the MemoryLane codebase for bloat, duplication, and optimization opportunities."
argument-hint: "Review the whole app for oversized files, duplicated logic, and safe optimization opportunities"
agent: "agent"
---

Audit the MemoryLane desktop app for code bloat and optimization opportunities.

Context:
- Windows-first, local-first Tauri v2 + React + TypeScript frontend with a Rust backend.
- Main source surfaces include [src/App.tsx](../../src/App.tsx), [src/App.css](../../src/App.css), [src/main.tsx](../../src/main.tsx), [src-tauri/src/lib.rs](../../src-tauri/src/lib.rs), [src-tauri/src/main.rs](../../src-tauri/src/main.rs), [scripts/tauri-dev.mjs](../../scripts/tauri-dev.mjs), [package.json](../../package.json), and [src-tauri/tauri.conf.json](../../src-tauri/tauri.conf.json).
- Treat generated build output and dependency folders as non-source noise. Do not flag `src-tauri/target/`, `target/`, `node_modules/`, or similar artifacts as code bloat.

Review scope:
- Oversized modules, mixed responsibilities, duplicated logic, dead code, and overly broad helpers.
- React component boundaries, state ownership, rendering hotspots, derived data, and repeated UI patterns.
- Rust backend command grouping, command fan-out, error handling, and file or IO logic that could be isolated.
- Build scripts, config files, and generated files that should not be manually maintained.
- CSS that has grown too large or too coupled to component structure.
- Redundant abstractions and places where splitting files would make the code easier to reason about.
- Safe optimizations that reduce work without changing behavior.

What to do:
1. Start with the biggest likely hotspots and prove whether they are actually bloated.
2. For each finding, cite the file, approximate line range, and the specific smell.
3. Recommend the smallest useful refactor boundary: delete, split, extract, simplify, or optimize.
4. Separate confirmed issues from hypotheses.
5. Keep the first pass read-only unless a tiny safe refactor is clearly justified.

Output format:
- Executive summary.
- Top bloat hotspots with severity order.
- Recommended file splits.
- Dead or unused code candidates.
- Performance hotspots.
- Refactor sequence in the safest order.
- Items to leave alone for now.

For every item, include:
- why it is a problem
- the likely root cause
- the exact fix
- risk level
- estimated effort
- whether it is a cleanup, split, deletion, or optimization

After the audit, end with a short execution plan that starts with the safest, highest-value changes.