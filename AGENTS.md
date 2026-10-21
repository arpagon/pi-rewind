# AGENTS.md

This file provides guidance to AI coding agents working on this repository.

> **Language Note**: Users may interact in Spanish, but all code, comments, documentation, and responses should be in English.

## Project Overview

**pi-rewind** is a checkpoint/rewind extension for the [Pi coding agent](https://github.com/badlogic/pi-mono). It creates automatic git-based snapshots of your working tree, allowing you to rewind file changes and conversation state when the AI makes mistakes.

## Goals

- Match or exceed the rewind experience of Claude Code, Gemini CLI, and Cline
- Provide a dedicated `/rewind` command on Pi and `/rw` on omp (omp reserves `/rewind` and `Esc+Esc`)
- Per-tool checkpointing (not just per-turn)
- Safe restore that never deletes ignored directories or large files
- Checkpoint browser with diff preview before restore
- Redo stack for multi-level undo

## Architecture

This project is a fork/rewrite inspired by two existing Pi extensions:

- **checkpoint-pi** (base) — [prateekmedia/pi-hooks](https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint): Two-layer architecture (core + extension), unit tests, safe restore, smart filtering
- **pi-rewind-hook** (UX inspiration) — [nicobailon/pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook): Resume checkpoints, footer status, notifications, auto-pruning, undo last rewind

### Key Design Decisions

- **Two-layer split**: `core/` for pure git operations (no pi dependency, independently testable) and `extension/` for pi API glue
- **Git refs storage**: Checkpoints stored as git refs under `refs/pi-checkpoints/`
- **Smart filtering**: Exclude `node_modules`, `.venv`, `dist`, `build`, large files (>10MiB), large dirs (>200 files)
- **Safe restore**: Track pre-existing untracked files and never delete them on restore

## Tech Stack

- TypeScript (loaded via jiti, no compilation needed)
- Pi extension API (`@mariozechner/pi-coding-agent`)
- Git (via `child_process.spawn`, no shell injection)
- No external runtime dependencies

## File Structure

```
pi-rewind/
├── AGENTS.md              # This file
├── README.md              # User-facing documentation
├── package.json           # Pi package manifest
├── src/
│   ├── index.ts           # Extension entry point
│   ├── core.ts            # Pure git operations (no pi deps)
│   ├── commands.ts        # /rewind + /rw registration, fork/branch/tree handlers
│   ├── state.ts           # Shared mutable state
│   └── ui.ts              # Status indicators, notifications
├── tests/
│   ├── core.test.ts       # Unit tests for core git operations
│   └── extension.test.ts  # Extension load, command/event, and fork-handler smoke test
└── docs/
    └── planning/          # Research and planning documents
```

## Development

```bash
# Test with pi
pi -e ./src/index.ts

# Run tests
npx tsx tests/core.test.ts
npx tsx tests/extension.test.ts

# Install globally
pi install /path/to/pi-rewind
```

## Pi Extension API Reference

Key events used:
- `session_start` (Pi) / `session_switch` (omp) — initialize or re-initialize checkpoint state; forks keep the parent's checkpoints
- `turn_start` / `turn_end` — Create per-turn checkpoints
- `tool_execution_end` — Create per-tool checkpoints (write, edit, ast_edit, bash)
- `session_before_fork` (Pi) / `session_before_branch` (omp) — Offer restore options before forking/branching
- `session_before_tree` / `session_tree` — Offer restore options before navigation (Pi) or after it (omp)

Key APIs used:
- `pi.registerCommand()` — Register `/rewind` (Pi) and `/rw` (omp)
- `pi.on()` — Subscribe to lifecycle events
- `ctx.ui.select()` / `ctx.ui.notify()` / `ctx.ui.setStatus()` — User interaction
- `ctx.compact()` — "Summarize from here" integration
- `pi.exec()` — Execute git commands

## Coding Guidelines

- All git operations go in `core.ts` with no pi imports
- Use `spawn()` for git commands, never `exec()` with shell
- Handle errors gracefully — checkpoint failures should never block the agent
- Truncate git ref names to safe characters only
- Batch file operations (100 files per git add)
- Always create a before-restore checkpoint before any restore operation
