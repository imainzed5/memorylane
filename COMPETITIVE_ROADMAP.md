# MemoryLane Competitive Roadmap

## Goal
Make MemoryLane feel competitive with the best local-first desktop capture apps by improving retrieval, trust, and review speed without losing the Windows-first, offline, private feel.

## Priority Order
1. Retrieval quality
2. Trust and privacy
3. Review power tools
4. Onboarding and polish
5. Reliability and shipping

## Phase 1: Retrieval Quality
### Objective
Make the app better at answering "what was I doing?" across time.

### Work Items
- Improve search ranking so the most relevant captures appear first.
- Enrich capture metadata with app name, window title, session context, and time signals.
- Keep improving OCR and note indexing so search has more than one signal.
- Add explainable match reasons so users know why a result returned.
- Group captures into sessions or focus blocks for time-based understanding.
- Add better query handling for natural-language time phrases like "around 3 PM yesterday."

### Ship Criteria
- Search feels clearly better than a simple text filter.
- The app can answer context questions without manual scrubbing.
- Users can tell why a result matched.

## Phase 2: Trust and Privacy
### Objective
Make MemoryLane safe to run on a work machine or shared laptop.

### Work Items
- Add app and window exclusions.
- Add sensitive-window detection and suppression rules.
- Add pause rules that can stop capture by app, window, or mode.
- Add manual redaction for screenshots and sensitive metadata.
- Make retention, backup, and storage controls easier to understand.
- Clarify what is local, what is backed up, and what is deleted automatically.

### Ship Criteria
- Users can reliably prevent sensitive content from being captured or surfaced.
- Privacy controls are visible, understandable, and easy to change.
- Backup and retention behavior feels explicit rather than hidden.

## Phase 3: Review Power Tools
### Objective
Help users return to important moments quickly.

### Work Items
- Add bookmarks for important captures.
- Add favorites for frequently referenced moments.
- Add tags for user-defined organization.
- Add side-by-side compare for adjacent or saved captures.
- Add quick-jump actions for bookmarks, favorites, and tags.
- Consider pinning sessions or days that matter most.

### Ship Criteria
- A user can mark and revisit an important moment in one or two actions.
- The app becomes a review tool, not just a scrollable archive.

## Phase 4: Onboarding and Polish
### Objective
Make the app feel native, clear, and easy to trust.

### Work Items
- Add first-run guidance for tray behavior, capture cadence, and shortcuts.
- Improve empty states so they tell users what to do next.
- Clean up the settings flow so it feels like a desktop app, not a web form.
- Tighten keyboard focus, shortcuts, and navigation.
- Refine copy, spacing, and shell hierarchy so the app feels less web-shaped.

### Ship Criteria
- New users understand the app quickly.
- Empty states and settings feel intentional.
- Keyboard users can move through the app without friction.

## Phase 5: Reliability and Shipping
### Objective
Make the product dependable enough to install and keep using.

### Work Items
- Improve capture reliability across sleep, resume, multi-monitor, and DPI changes.
- Harden tray and startup recovery behavior.
- Add signed installers for trust.
- Add auto-update support.
- Keep release notes and diagnostics clear.
- Preserve the current GitHub release flow so tagged builds stay easy to publish.

### Ship Criteria
- The app keeps working after common Windows interruptions.
- Installs feel trustworthy.
- Shipping a new release is predictable.

## Supporting Work
These are important, but they should not block the main roadmap unless they directly help the core experience.

- Data portability: better backup verification, restore checks, and export options.
- Performance: keep metadata-first loading, fast search, and on-demand image fetching.
- Accessibility: stronger focus states, clearer controls, and better keyboard flow.
- Diagnostics: lightweight error reporting that does not leak private content.

## Suggested Build Order
1. Retrieval quality.
2. Trust and privacy.
3. Review power tools.
4. Onboarding and polish.
5. Reliability and shipping.

## Definition of Done
MemoryLane feels competitive when:
- Search is fast, explainable, and context-rich.
- Sensitive content controls are obvious and reliable.
- Users can save, label, and return to important moments quickly.
- New users understand the app without a manual.
- The app feels like a native Windows desktop product, not a web page in a frame.
