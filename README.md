# pi-rewind

Checkpoint/rewind extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). Creates automatic git-based snapshots of your working tree, allowing you to rewind file changes and conversation state when the AI makes mistakes.

## Why

Every major coding agent now has rewind/undo: Claude Code (`/rewind`), Gemini CLI (`/rewind`), OpenCode (`/undo`), Cline (Checkpoints). Pi already has community extensions for this — [checkpoint-pi](https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint) and [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) — but neither offers a dedicated `/rewind` command, per-tool granularity, or a redo stack.

**pi-rewind** combines the best of both existing extensions with features from the top agents, closing every gap in one package.

## Features

- [x] Dedicated `/rewind` command — checkpoint browser → diff preview → restore
- [x] `Esc+Esc` keyboard shortcut — quick files-only rewind
- [x] Per-tool checkpointing — after each write, edit, bash
- [x] Per-turn checkpointing — snapshot at start of every turn
- [x] Checkpoint browser with diff preview before restore
- [x] Redo stack (multi-level undo) — "↩ Undo last rewind" in all flows
- [x] Restore options: files + conversation, files only, conversation only
- [x] Safe restore — never deletes `node_modules`, `.venv`, or large files
- [x] Smart filtering — excludes 13 dir patterns, files >10MiB, dirs >200 files
- [x] Git-based checkpoints stored as refs (survives restarts)
- [x] Footer status indicator (`◆ X checkpoints`)
- [x] Auto-pruning (100 max checkpoints per session)
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

## Architecture

Two-layer split: `core.ts` is pure git operations with zero Pi dependency (independently testable), `index.ts` wires Pi events to core functions.

```
src/
├── core.ts       # 646 LOC — git operations, filtering, safe restore
├── index.ts      # 201 LOC — Pi event hooks, checkpoint scheduling
├── commands.ts   # 328 LOC — /rewind, Esc+Esc, fork/tree handlers
├── state.ts      #  50 LOC — shared mutable state
└── ui.ts         #  33 LOC — footer status indicator
tests/
└── core.test.ts  # 327 LOC — 19 tests passing
```

## Development

```bash
# Run tests
npx tsx tests/core.test.ts

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
