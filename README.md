# pi-rewind

Checkpoint/rewind extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). Creates automatic git-based snapshots of your working tree, allowing you to rewind file changes and conversation state when the AI makes mistakes.

## Why

Every major coding agent now has rewind/undo: Claude Code (`/rewind`), Gemini CLI (`/rewind`), OpenCode (`/undo`), Cline (Checkpoints). Pi doesn't have it built-in, but its extension API is powerful enough to match or exceed them all.

**pi-rewind** aims to be the best rewind experience for Pi, combining the strengths of existing community extensions with features from the top agents.

## Features (Planned)

- [x] Git-based checkpoints stored as refs (survives restarts)
- [x] Safe restore — never deletes `node_modules`, `.venv`, or large files
- [x] Smart filtering — excludes build artifacts and large directories
- [x] Restore options: files + conversation, files only, conversation only
- [x] Undo last rewind safety net
- [ ] Dedicated `/rewind` command
- [ ] `Esc+Esc` keyboard shortcut
- [ ] Per-tool checkpointing (after each write/edit/bash)
- [ ] Checkpoint browser with diff preview
- [ ] Redo stack (multi-level undo)
- [ ] "Summarize from here" integration
- [ ] Footer status indicator (`◆ X checkpoints`)
- [ ] Auto-pruning (configurable max checkpoints)
- [ ] Resume checkpoint on session start

## Install

```bash
pi install github.com/arpagon/pi-rewind
```

Or for development:

```bash
git clone git@github.com:arpagon/pi-rewind.git
pi -e ./pi-rewind/src/index.ts
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
