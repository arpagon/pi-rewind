# Changelog

All notable changes to pi-rewind follow the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## [0.6.0] — 2026-06-21

### Added

- `/rewind-settings` — interactive config menu (`maxCheckpoints`, `keepOldSessions`, `cleanupHintThreshold`), auto-saves on every change.
- `/rewind-cleanup` — stats overview + prune options for old sessions and current session.
- Configuration file support at `~/.pi/agent/config/rewind.json` with environment variable overrides (`PI_REWIND_MAX_CHECKPOINTS`, `PI_REWIND_KEEP_OLD_SESSIONS`, `PI_REWIND_CLEANUP_HINT_THRESHOLD`).
- `getCheckpointStats`, `pruneAllOldSessions`, `deleteCheckpointsBulk`, and `diffCheckpoints` to `core.ts`.

### Changed

- **Cross-session persistence** — when `keepOldSessions` is `true`, checkpoints survive across pi restarts. The `/rewind` picker becomes a two-step flow (session → checkpoint) instead of current-session-only. Previously all old-session checkpoints were pruned unconditionally on startup.
- Auto-pruning is now configurable via `maxCheckpoints`. Set to `0` to disable per-session pruning entirely. Default remains `50`.
- Toggling `keepOldSessions` off in `/rewind-settings` now prunes old session refs immediately rather than waiting for the next session start.
- Footer status now shows a cleanup hint (`◆ N checkpoints (consider /rewind-cleanup)`) when the total exceeds `cleanupHintThreshold`.
- README updated with accurate LOC counts, new architecture diagram including `config.ts`, and new Commands and Configuration sections.

### Fixed

- Dead code in `pruneOldSessions`: removed unused `name` variable and redundant `replace()` call.

### Backward Compatibility

Defaults (`maxCheckpoints: 50`, `keepOldSessions: false`, `cleanupHintThreshold: 200`) match the original behavior exactly. No migration needed.

### Test Coverage

- 6 new unit tests for cross-session pruning, bulk delete, checkpoint stats, and diff (26 total, 0 failures).
