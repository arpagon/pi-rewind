# Planning: pi-rewind Extension

## Objective

Build the best possible checkpoint/rewind extension for Pi, matching or exceeding Claude Code, Gemini CLI, Cline, and OpenCode.

## Source Repos to Study

### Base (fork from)
- **checkpoint-pi**: https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint
  - `checkpoint.ts` (492 LOC) — Extension glue, pi event handlers, restore UI
  - `checkpoint-core.ts` (907 LOC) — Pure git operations, no pi dependency
  - `tests/checkpoint.test.ts` (906 LOC) — Unit tests for core
  - Key strengths: 2-layer architecture, safe restore, smart filtering, HEAD+index+worktree capture

### UX Inspiration (cherry-pick from)
- **pi-rewind-hook**: https://github.com/nicobailon/pi-rewind-hook
  - `index.ts` (610 LOC) — Monolithic single-file extension
  - Key strengths: Resume checkpoint, footer status (`◆ X checkpoints`), notifications, silent mode config, auto-pruning (100 max), "Undo last file rewind" menu, backward compat with v1.2 format

### Feature Parity Targets
- **Claude Code** (Anthropic): https://github.com/anthropics/claude-code
  - Docs: https://docs.anthropic.com/en/docs/claude-code/checkpointing
  - Feature: `/rewind` command, `Esc+Esc` shortcut, "Summarize from here"
  - Tracks: AI file edits only (NOT bash changes)
  - Storage: Internal checkpoints, auto-clean ~30 days

- **OpenCode** (anomalyco): https://github.com/anomalyco/opencode (was github.com/sst/opencode)
  - Feature: `/undo` (`ctrl+x u`), `/redo` (`ctrl+x r`)
  - Tracks: Step-level workspace patches (tool + terminal-induced)
  - Storage: Shadow snapshot Git + SQLite
  - Key files: `session/revert.ts`, `snapshot/index.ts`, `storage/db.ts`

- **Gemini CLI** (Google): https://github.com/google-gemini/gemini-cli
  - Feature: `/rewind`, `/restore [tool_call_id]`, `Esc+Esc`
  - Tracks: AI edit-tool file changes only
  - Storage: Shadow Git + JSON checkpoints
  - Checkpointing disabled by default

- **Cline**: https://github.com/cline/cline
  - Feature: Checkpoints per tool call, Compare/Restore buttons
  - Tracks: File edits AND command-driven changes
  - Storage: Shadow Git repo (`globalStorage/checkpoints/<cwdHash>/.git`)
  - Ranked #1 in our research

- **Aider**: https://github.com/Aider-AI/aider
  - Feature: `/undo` — only undoes last aider commit
  - Simple but limited

- **Codex CLI** (OpenAI): https://github.com/openai/codex
  - Feature: `Esc+Esc` ThreadRollback (conversation only), experimental `undo` ghost snapshots
  - Key files: `codex-rs/core/src/rollout/list.rs`

### Pi Extension API Reference
- **Extensions docs**: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- **Key events**: `session_start`, `turn_start`, `turn_end`, `tool_execution_start/end`, `session_before_fork`, `session_before_tree`
- **Key APIs**: `pi.registerCommand()`, `pi.registerShortcut()`, `ctx.ui.select()`, `ctx.ui.setStatus()`, `ctx.compact()`

### Community Resources
- **awesome-pi-agent**: https://github.com/qualisero/awesome-pi-agent — Community extensions list

## Ranked Feature Priorities

| Priority | Feature | Effort | Impact |
|---|---|---|---|
| P0 | Fork checkpoint-pi + cherry-pick rewind-hook UX | Low | High |
| P1 | Register `/rewind` command | Low | High |
| P1 | Per-tool checkpointing (`tool_execution_end`) | Medium | High |
| P2 | `Esc+Esc` keyboard shortcut | Low | Medium |
| P2 | Redo stack (multi-level undo) | Medium | Medium |
| P3 | Diff preview before restore | High | Medium |
| P3 | "Summarize from here" integration | Medium | Medium |

## Architecture Plan

```
src/
├── index.ts          # Extension entry point, event wiring
├── core.ts           # Pure git operations (from checkpoint-pi core, enhanced)
├── commands.ts       # /rewind command + shortcut registration
├── ui.ts             # Footer status, notifications, checkpoint browser
└── types.ts          # Shared types
tests/
└── core.test.ts      # Unit tests (from checkpoint-pi, expanded)
```

## Key Differences from checkpoint-pi

1. Add `/rewind` command (not just fork/tree hooks)
2. Add per-tool checkpointing (not just per-turn)
3. Add resume checkpoint on session start
4. Add footer status indicator
5. Add auto-pruning with configurable max
6. Add `Esc+Esc` shortcut
7. Add redo stack
8. Keep: safe restore, smart filtering, 2-layer architecture, tests
