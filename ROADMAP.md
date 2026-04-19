# MemoryLane MVP Roadmap

This roadmap is organized around the product shape MemoryLane is already moving toward: local-first capture, fast retrieval, meaningful summaries, trust, and keyboard-first speed. The MVP should feel like a real memory system, not just a screenshot bucket.

## Product Goal

Ship a Windows desktop app that can:

- Capture the screen automatically in the background.
- Search screenshots and notes by text, time, and meaning.
- Summarize what happened during a day.
- Keep the archive private, portable, and safe.
- Stay fast enough that browsing history feels instant.

## Non-Goals For The MVP

- No cloud sync.
- No shared account system.
- No multi-device sync.
- No cross-platform support before the Windows experience is solid.
- No hosted backend required for core retrieval or summaries.

## Phase 0: Stabilize The Data Model

Goal: make the app ready to index more meaning without breaking existing installs.

Milestones:

- Split capture persistence into explicit layers for image files, thumbnails, notes, and search metadata.
- Add schema migrations for older databases so new fields can be introduced safely.
- Create a place to store OCR output, OCR status, and indexing timestamps per capture.
- Keep the current capture flow working while the new metadata layer is introduced.
- Add a background-job boundary so heavy work does not block capture creation.

Tests:

- Fresh install creates the expected schema.
- Legacy install migrates without losing captures or notes.
- Existing day navigation still loads after migration.
- Capture creation still succeeds when new metadata fields are empty.
- Database schema tests cover both upgrade and downgrade-safe behavior where applicable.

Definition of done:

- Old installs open.
- New installs create the extended schema.
- Capture creation remains reliable.

Implementation plan:

1. Audit the current SQLite schema and capture write path in src-tauri/src/lib.rs.
2. Add the new columns or companion tables needed for OCR, indexing, and summary metadata.
3. Write migrations for existing installs and tests for fresh and upgraded databases.
4. Add a small async work boundary so later OCR and indexing jobs can hook in without blocking capture_once.

## Phase 1: Make Retrieval The Core Feature

Goal: let users find moments by what was on screen, what they wrote, and when it happened.

Milestones:

- Run OCR locally after capture files are written.
- Store extracted text in a searchable form.
- Add a unified search command that searches capture notes, OCR text, and capture timestamps together.
- Add snippets or highlights so users can see why a result matched.
- Add ranking that prefers exact note matches, exact OCR matches, and then broader time-based matches.
- Keep search responsive even when the archive is large.

Tests:

- OCR on a known fixture image extracts the expected text.
- Search returns captures matched by OCR text.
- Search returns captures matched by notes.
- Search returns captures matched by date or time phrases.
- Search ranking prefers a capture with an exact OCR hit over a weak time-only hit.
- Capture creation remains non-blocking while OCR runs in the background.

Definition of done:

- A user can type a phrase and find it across screenshots and notes.
- The app can answer time-based lookups without opening every capture manually.

Implementation plan:

1. Add a local OCR step that runs after each new capture is written.
2. Persist OCR output and indexing status per capture.
3. Add a backend search command that queries notes, OCR text, and timestamp fields together.
4. Introduce ranking and snippet generation so results explain themselves.
5. Add fixture-based tests for OCR extraction and search ranking.

## Phase 2: Turn Retrieval Into A Better UI

Goal: make search and review feel instant, keyboard-first, and easier than any competitor.

Milestones:

- Replace the current single filter field with a richer retrieval surface.
- Add a search mode that accepts text, note keywords, and natural-language time queries.
- Add keyboard shortcuts for search focus, next and previous match, and clearing a query.
- Add visible match context so the user can see which capture and which text made the result relevant.
- Keep the current timeline virtualization and paging model.
- Preserve day navigation, capture notes, and deletion flows.

Tests:

- Keyboard-only users can open search, query, and move through matches without a mouse.
- The timeline still loads correctly for a day with many captures.
- Search and day navigation remain stable when the selected capture changes.
- Empty-state and no-match states show useful guidance.
- Large result sets do not freeze the UI.

Definition of done:

- Search feels like the primary way to use the app.
- The timeline is still there, but it is no longer the only retrieval path.

Implementation plan:

1. Replace the current search input with a retrieval bar that can accept text and time phrases.
2. Wire the new search command into the existing React state flow.
3. Add keyboard shortcuts for search focus, stepping through results, and clearing queries.
4. Add a results context panel or inline match summary so users can see why a result matched.
5. Keep the virtualized timeline and paging logic intact while the new UI lands.

## Phase 3: Add Meaning Layers

Goal: turn raw captures into a memory of the day, not just storage.

Milestones:

- Generate a daily summary from the captures in a day.
- Add a "what changed today" view that highlights notable shifts from the prior state or prior day.
- Add task or session clustering based on time gaps, note patterns, and repeated context.
- Group captures into readable blocks like focus sessions, review sessions, or release work.
- Keep clusters explainable so the user can understand why captures were grouped.
- Surface the summary and cluster view alongside the timeline rather than replacing it.

Tests:

- A fixture day produces a deterministic summary.
- Cluster grouping is stable for the same sample data.
- "What changed today" output includes the expected capture ranges.
- Adding a note updates the relevant summary or cluster display after refresh.
- Summary generation does not block normal browsing.

Definition of done:

- The app can say more than "here are screenshots".
- It can describe the shape of the day in plain language.

Implementation plan:

1. Build a day-summary generator from the capture rows already returned by get_day_summaries.
2. Add clustering logic based on time gaps, repeated context, and note changes.
3. Add a "what changed today" view that compares the active day to adjacent history.
4. Surface summaries and clusters in a lightweight sidebar or drawer rather than a separate screen.
5. Add deterministic fixture tests for summary and cluster output.

## Phase 4: Build Trust As A Feature

Goal: make the archive feel private, durable, and portable.

Milestones:

- Encrypt capture assets and sensitive metadata at rest.
- Store or derive the local key in a way that fits Windows desktop expectations.
- Add encrypted backup export for the full archive.
- Add restore/import that verifies integrity before replacing live data.
- Add a privacy story in the UI and landing page that is simple and explicit.
- Make the storage location and retention rules visible to the user.

Tests:

- Encrypted data cannot be read as plain files without the key.
- Backup export and restore round-trip the full archive successfully.
- Restore rejects corrupt or partial bundles safely.
- Existing captures remain readable after migration to the encrypted format.
- The app still opens the archive and timeline after restore.

Definition of done:

- The user can trust the archive is local and protected.
- The user can move data in and out without losing history.

Implementation plan:

1. Define the encryption boundary for image files, thumbnails, OCR caches, and sensitive metadata.
2. Add local key generation and a Windows-friendly key storage strategy.
3. Implement encrypted export into a portable archive format.
4. Implement restore with integrity validation before any live data is replaced.
5. Add tests for round-trip restore, corrupt bundle rejection, and migration into encrypted storage.

## Phase 5: Win On Speed And Friction

Goal: make the app feel lighter, faster, and more direct than alternatives.

Milestones:

- Keep metadata-first loading so the timeline appears before full images.
- Cache OCR and search results so repeat queries are cheap.
- Keep full-size image loading on demand only.
- Add performance budgets for timeline loading and search response.
- Polish keyboard flows for capture review, deletion, and time jumping.
- Reduce modal and click friction for the most common actions.

Tests:

- Opening a day with many captures stays within the performance budget.
- Repeated search queries return quickly from cache.
- Keyboard shortcuts still work after adding new retrieval surfaces.
- Switching days does not lose the selected capture unexpectedly.
- The UI remains usable on large archives with no noticeable jank.

Definition of done:

- The app feels instant in normal use.
- The most common tasks can be done from the keyboard.

Implementation plan:

1. Keep metadata-first loading and image-on-demand behavior as the default rendering path.
2. Cache OCR and search results so repeat queries and revisits are cheap.
3. Add performance guards for large days, repeated search, and result navigation.
4. Tighten keyboard flows around the most common retrieval actions.
5. Measure and tune the slowest paths before release.

## MVP Release Criteria

The MVP is ready to ship when:

- OCR text is searchable.
- Notes, OCR text, and time queries all hit the same retrieval layer.
- Daily summaries or cluster views exist and are useful.
- Encryption at rest and encrypted backup or restore are in place.
- The app still feels fast, local, and keyboard-first.

## Suggested Build Order

1. Stabilize schema and capture metadata.
2. Add OCR and search indexing.
3. Rework the UI around retrieval.
4. Add summaries and clustering.
5. Add encryption and backup or restore.
6. Tune performance and keyboard flow.

## Test Matrix To Keep Running

- Fresh install smoke test.
- Legacy database upgrade test.
- Capture-now smoke test.
- OCR extraction fixture test.
- Unified search ranking test.
- Day summary and cluster fixture test.
- Encrypted backup and restore round-trip test.
- Large timeline navigation smoke test.
- Keyboard-only navigation smoke test.

## Notes For Implementation

- Keep OCR and indexing asynchronous so capture scheduling stays reliable.
- Treat search as a platform feature, not a sidebar filter.
- Prefer explainable summaries and clusters over opaque automation.
- Keep privacy copy visible and unambiguous.
- Avoid adding cloud dependencies while the local experience is still being built out.