# pi-rewind

Checkpoint/rewind extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). Creates automatic git-based snapshots of your working tree, allowing you to rewind file changes and conversation state when the AI makes mistakes.

## Why

Every major coding agent now has rewind/undo: Claude Code (`/rewind`), Gemini CLI (`/rewind`), OpenCode (`/undo`), Cline (Checkpoints). Pi already has community extensions for this — [checkpoint-pi](https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint) and [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) — but neither offers a dedicated `/rewind` command, diff preview, or a redo stack.

**pi-rewind** combines the best of both existing extensions with features from the top agents, closing every gap in one package.

## Features

- [x] Dedicated `/rewind` command — checkpoint browser → diff preview → restore
- [x] `Esc+Esc` keyboard shortcut — quick files-only rewind
- [x] Smart checkpointing — snapshots after write/edit/bash tools, 1 per turn
- [x] Smart dedup — skips checkpoints when worktree unchanged (read-only bash like `ls`, `find`, `cat` don't create checkpoints)
- [x] Descriptive labels — `"user prompt" → write → file.ts, edit → other.ts`
- [x] Diff preview before restore — see exactly what changes
- [x] Branch labels in picker — `[feature]` for same-branch, `⚠️ main` for cross-branch
- [x] Redo stack (multi-level undo) — "↩ Undo last rewind" in all flows
- [x] Restore options: files + conversation, files only, conversation only
- [x] Safe restore — never deletes `node_modules`, `.venv`, or large files
- [x] Branch safety — blocks cross-branch restore (avoids OpenCode bug)
- [x] Smart filtering — excludes 13 dir patterns, files >10MiB, dirs >200 files
- [x] Git-based checkpoints stored as refs (survives restarts)
- [x] Footer status indicator (`◆ X checkpoints`) with cleanup hint
- [x] Configurable auto-pruning — `maxCheckpoints` (0=unlimited), `keepOldSessions`, `cleanupHintThreshold`
- [x] Cross-session checkpoint picker — two-step (session → checkpoint) when old sessions kept
- [x] `/rewind-settings` — interactive config menu, auto-saves on change
- [x] `/rewind-cleanup` — stats + prune options for current and old sessions
- [x] Resume checkpoint on session start
- [x] Fork/tree integration — restore prompts on `/fork` and `/tree` navigation
- [ ] "Summarize from here" integration (`ctx.compact()`)

## Install

```bash
# From npm
pi install npm:pi-rewind

# From GitHub
pi install github.com/arpagon/pi-rewind

# For development
git clone git@github.com:arpagon/pi-rewind.git
pi -e ./pi-rewind/src/index.ts
```

## Commands

| Command | Behavior |
|---|---|
| `/rewind` | Checkpoint browser → diff preview → restore. Two-step cross-session picker when `keepOldSessions` is true |
| `/rewind-cleanup` | Stats overview + prune options (old sessions, current session to max) |
| `/rewind-settings` | Interactive settings menu, auto-saves on every change |
| `Esc+Esc` | Quick files-only rewind (cross-session aware) |

## Configuration

Config lives at `~/.pi/agent/config/rewind.json` (auto-created on first save). Environment variables override file settings.

```json
{
  "maxCheckpoints": 50,          // 0 = unlimited, never prune current session
  "keepOldSessions": false,       // true = keep checkpoints from previous sessions
  "cleanupHintThreshold": 200     // show cleanup hint when checkpoints exceed this
}
```

| Env var | Overrides |
|---|---|
| `PI_REWIND_MAX_CHECKPOINTS` | `maxCheckpoints` |
| `PI_REWIND_KEEP_OLD_SESSIONS` | `keepOldSessions` (set to `1`, `true`, or `yes`) |
| `PI_REWIND_CLEANUP_HINT_THRESHOLD` | `cleanupHintThreshold` |

Use `/rewind-settings` to change config live — no restart needed.

## Performance

Tested on repos from 20 files to 182K files (87GB monorepo):

| Repo | createCheckpoint | loadAll (startup) |
|---|---|---|
| Small (20 files) | 62ms | 8ms |
| Medium (500 files) | 62ms | 8ms |
| Large (5,000 files) | 60ms | 8ms |
| Real monorepo (182K files, 87GB) | 142ms | 8ms |

- `createCheckpoint` = ~60-142ms constant → direct latency added per turn (imperceptible)
- Pi executes extension handlers with `await` sequentially, so this is the actual overhead
- Old sessions are auto-pruned on startup (525 stale refs → 0 in real-world test)

Run the benchmark yourself: `npx tsx tests/bench.ts`

## Architecture

Two-layer split: `core.ts` is pure git operations with zero Pi dependency (independently testable), `index.ts` wires Pi events to core functions.

```
src/
├── config.ts     #  87 LOC — load/save rewind.json, env var overrides
├── core.ts       # 830 LOC — git operations, filtering, safe restore, branch safety, prune, stats
├── index.ts      # 284 LOC — Pi event hooks, checkpoint scheduling, auto-prune
├── commands.ts   # 741 LOC — /rewind, /rewind-cleanup, /rewind-settings, Esc+Esc, fork/tree
├── state.ts      #  79 LOC — shared mutable state (config preserved across resets)
└── ui.ts         #  49 LOC — footer status, cleanup hint, threshold notifications
tests/
├── core.test.ts  # 362 LOC — 20 tests passing
└── bench.ts      # 252 LOC — performance benchmarks
```

## Development

```bash
# Run tests
npx tsx tests/core.test.ts

# Run benchmarks
npx tsx tests/bench.ts

# Test with Pi
pi -e ./src/index.ts
```

## Lineage

This project builds on research and code from:

- **[checkpoint-pi](https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint)** by prateekmedia — Two-layer architecture, safe restore, smart filtering, unit tests (base)
- **[pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook)** by nicobailon — Resume checkpoints, footer status, notifications, auto-pruning (UX inspiration)

And draws feature parity targets from:
- Claude Code `/rewind` — Summarize from here, double-escape trigger
- Gemini CLI `/rewind` + `/restore` — Separate restore commands
- Cline Checkpoints — Per-tool checkpointing, Compare/Restore UI
- OpenCode `/undo` + `/redo` — Step-level patches, redo stack

## License

MIT
