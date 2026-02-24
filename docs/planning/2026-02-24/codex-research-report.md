thinking
**Summarizing rewind feature research**
codex
**Ranked Comparison (Rewind/Undo Quality)**
Ranking criterion: how complete and reliable the rewind experience is for real coding sessions (files + conversation + UX + storage robustness).

| Rank | Agent | Exact feature + trigger | Tracks what | Storage | Conversation restore | Key limitations |
|---|---|---|---|---|---|---|
| 1 | **Cline** | **Checkpoints** UI after each tool use; **Compare** / **Restore** buttons | File edits and command-driven file changes (docs: after file edits and commands) | Shadow Git repo (`globalStorage/checkpoints/<cwdHash>/.git`) | **Yes** (`Restore Files`, `Restore Task Only`, `Restore Files & Task`) | Disabled in multi-root workspaces; can be heavy on very large repos |
| 2 | **Gemini CLI** | **`/rewind`** (or **Esc Esc**), **`/restore [tool_call_id]`**, `/chat save/resume` | `/rewind`: AI edit-tool file changes only; excludes manual + shell (`!`) changes | Shadow Git (`~/.gemini/history/...`) + JSON checkpoints/chats (`~/.gemini/tmp/...`) | **Yes** (rewind-only, files-only, both; `/restore` restores both) | Checkpointing disabled by default; shell/manual edits not rewound |
| 3 | **Claude Code** | **`/rewind`** (or **Esc Esc**) | AI file changes; docs explicitly say Bash tool changes are not tracked | Automatic checkpoints (implementation details not publicly documented), auto-clean ~30 days | **Yes** (files only / conversation only / both) | Bash side effects not tracked |
| 4 | **OpenCode** | **`/undo`** (`ctrl+x u`), **`/redo`** (`ctrl+x r`) | Step-level workspace patches (tool + terminal-induced file edits) | Shadow snapshot Git + SQLite (`opencode.db`) | **Yes** | Requires Git repo; `/undo`/`/redo` unsupported in ACP mode |
| 5 | **Cursor** (additional) | **Revert checkpoints and branch snapshots** in Chat UI | Codebase checkpoints + branch snapshots (public docs don’t fully split tool vs shell) | Not publicly documented | **Partial/Yes** (via branch snapshots/checkpoints) | Internal mechanics not documented publicly |
| 6 | **Windsurf** | **Checkpoints / Reversions** via checkpoint icon | Codebase restore tied to prompt/tool-call flow | Not publicly documented | Not clearly documented | Scope/storage/shell coverage not clearly documented |
| 7 | **checkpoint-pi** (Pi extension) | Restore prompt on `session_before_fork` / `session_before_tree` | Full worktree + index + untracked snapshot at `turn_start` (source-agnostic for those points) | Git refs under `refs/pi-checkpoints` (commit-tree metadata) | **Yes** (`Restore all`, `Conversation only`, `Code only`) | No native checkpoint browser/diff UI; not per-tool granularity |
| 8 | **pi-rewind-hook** (Pi extension) | Restore menu in `/fork` and tree navigation; “Undo last file rewind” | Worktree snapshots at session start + first turn per user message (`turnIndex===0`) | Git refs under `refs/pi-checkpoints` | **Yes** | Coarser checkpoints; restores worktree only (not full index fidelity) |
| 9 | **Aider** | **`/undo`** | Last Git commit made by Aider in current chat session | User repo Git commits | **No** | Only last aider commit; blocked if pushed/dirty/merge/non-aider commit |
| 10 | **Codex CLI** | Stable: **Esc Esc backtrack + Enter** (`ThreadRollback`); Experimental: `undo` ghost snapshots (feature-flagged) | Stable rollback is conversation-only; experimental ghost commit can restore working tree | Rollout JSONL thread history (+ optional sqlite metadata), ghost commit Git objects | **Yes** (stable: conversation only) | Stable path does not revert files; undo path appears feature-gated/not default UX |
| 11 | **Crush** | No clear end-user rewind command found; internal file history exists | File versions for write/edit/multiedit tools; bash path not integrated | SQLite (`crush.db`) | **No** | No clear user-facing checkpoint restore flow |

---

**Pi: What Exists vs What’s Missing**

From `awesome-pi-agent`, the only file-rewind/checkpoint extensions are effectively:
1. `checkpoint-pi`  
2. `pi-rewind-hook`

`checkpoint-pi` is stronger technically (captures head/index/worktree state, safer restore behavior, tested edge cases).  
`pi-rewind-hook` is better UX in some spots today (explicit “Undo last file rewind”, session-start checkpoint behavior, checkpoint status indicator).

Main gaps vs best-in-class (Cline/Gemini/Claude):
1. No first-class checkpoint browser with diff preview before restore.
2. No direct `/rewind` command flow equivalent (currently piggybacks mainly on fork/tree).
3. No true per-tool checkpoint cadence (best agents checkpoint around each tool mutation).
4. No built-in redo/unrevert stack across multiple rewind steps.
5. Limited public UX around retention/cleanup/metadata visibility.

---

**Recommendation**

Use **`checkpoint-pi`** as the base today.

If you want Pi to match or exceed the best rewind experience:
1. Fork `checkpoint-pi` and add **per-tool checkpointing** using Pi tool lifecycle events (`tool_execution_start/end`) plus current turn snapshots.
2. Add a **checkpoint browser** command/UI (list, compare diff, restore mode selection).
3. Add **redo/unrevert stack** and clear retention controls.

That path gives you Cline/Gemini-level safety while keeping Pi-native fork/tree conversation semantics.

---

Sources:  
- OpenCode docs/code: `tui.mdx`, `acp.mdx`, `session/revert.ts`, `snapshot/index.ts`, `storage/db.ts`  
  https://github.com/sst/opencode  
- Claude Code rewind docs  
  https://docs.anthropic.com/en/docs/claude-code/interactive-mode#rewind  
  https://docs.anthropic.com/en/docs/claude-code/ide-integrations  
- Codex protocol/TUI/core  
  https://github.com/openai/codex  
- Gemini CLI rewind/checkpointing/docs/code  
  https://github.com/google-gemini/gemini-cli  
- Aider `/undo` + docs  
  https://github.com/Aider-AI/aider  
- Cline checkpoints docs/code  
  https://github.com/cline/cline  
- Crush history/tool/UI/db code  
  https://github.com/charmbracelet/crush  
- Windsurf checkpoints docs  
  https://docs.windsurf.com/windsurf/cascade/cascade  
- Cursor chat checkpoints docs  
  https://docs.cursor.com/chat/overview#revert-checkpoints-and-branch-snapshots  
- Pi extensions + list  
  https://github.com/nicobailon/pi-rewind-hook  
  https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint  
  https://github.com/qualisero/awesome-pi-agent  
- Pi extension API/events (build feasibility)  
  https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
tokens used
820,037
**Ranked Comparison (Rewind/Undo Quality)**
Ranking criterion: how complete and reliable the rewind experience is for real coding sessions (files + conversation + UX + storage robustness).

| Rank | Agent | Exact feature + trigger | Tracks what | Storage | Conversation restore | Key limitations |
|---|---|---|---|---|---|---|
| 1 | **Cline** | **Checkpoints** UI after each tool use; **Compare** / **Restore** buttons | File edits and command-driven file changes (docs: after file edits and commands) | Shadow Git repo (`globalStorage/checkpoints/<cwdHash>/.git`) | **Yes** (`Restore Files`, `Restore Task Only`, `Restore Files & Task`) | Disabled in multi-root workspaces; can be heavy on very large repos |
| 2 | **Gemini CLI** | **`/rewind`** (or **Esc Esc**), **`/restore [tool_call_id]`**, `/chat save/resume` | `/rewind`: AI edit-tool file changes only; excludes manual + shell (`!`) changes | Shadow Git (`~/.gemini/history/...`) + JSON checkpoints/chats (`~/.gemini/tmp/...`) | **Yes** (rewind-only, files-only, both; `/restore` restores both) | Checkpointing disabled by default; shell/manual edits not rewound |
| 3 | **Claude Code** | **`/rewind`** (or **Esc Esc**) | AI file changes; docs explicitly say Bash tool changes are not tracked | Automatic checkpoints (implementation details not publicly documented), auto-clean ~30 days | **Yes** (files only / conversation only / both) | Bash side effects not tracked |
| 4 | **OpenCode** | **`/undo`** (`ctrl+x u`), **`/redo`** (`ctrl+x r`) | Step-level workspace patches (tool + terminal-induced file edits) | Shadow snapshot Git + SQLite (`opencode.db`) | **Yes** | Requires Git repo; `/undo`/`/redo` unsupported in ACP mode |
| 5 | **Cursor** (additional) | **Revert checkpoints and branch snapshots** in Chat UI | Codebase checkpoints + branch snapshots (public docs don’t fully split tool vs shell) | Not publicly documented | **Partial/Yes** (via branch snapshots/checkpoints) | Internal mechanics not documented publicly |
| 6 | **Windsurf** | **Checkpoints / Reversions** via checkpoint icon | Codebase restore tied to prompt/tool-call flow | Not publicly documented | Not clearly documented | Scope/storage/shell coverage not clearly documented |
| 7 | **checkpoint-pi** (Pi extension) | Restore prompt on `session_before_fork` / `session_before_tree` | Full worktree + index + untracked snapshot at `turn_start` (source-agnostic for those points) | Git refs under `refs/pi-checkpoints` (commit-tree metadata) | **Yes** (`Restore all`, `Conversation only`, `Code only`) | No native checkpoint browser/diff UI; not per-tool granularity |
| 8 | **pi-rewind-hook** (Pi extension) | Restore menu in `/fork` and tree navigation; “Undo last file rewind” | Worktree snapshots at session start + first turn per user message (`turnIndex===0`) | Git refs under `refs/pi-checkpoints` | **Yes** | Coarser checkpoints; restores worktree only (not full index fidelity) |
| 9 | **Aider** | **`/undo`** | Last Git commit made by Aider in current chat session | User repo Git commits | **No** | Only last aider commit; blocked if pushed/dirty/merge/non-aider commit |
| 10 | **Codex CLI** | Stable: **Esc Esc backtrack + Enter** (`ThreadRollback`); Experimental: `undo` ghost snapshots (feature-flagged) | Stable rollback is conversation-only; experimental ghost commit can restore working tree | Rollout JSONL thread history (+ optional sqlite metadata), ghost commit Git objects | **Yes** (stable: conversation only) | Stable path does not revert files; undo path appears feature-gated/not default UX |
| 11 | **Crush** | No clear end-user rewind command found; internal file history exists | File versions for write/edit/multiedit tools; bash path not integrated | SQLite (`crush.db`) | **No** | No clear user-facing checkpoint restore flow |

---

**Pi: What Exists vs What’s Missing**

From `awesome-pi-agent`, the only file-rewind/checkpoint extensions are effectively:
1. `checkpoint-pi`  
2. `pi-rewind-hook`

`checkpoint-pi` is stronger technically (captures head/index/worktree state, safer restore behavior, tested edge cases).  
`pi-rewind-hook` is better UX in some spots today (explicit “Undo last file rewind”, session-start checkpoint behavior, checkpoint status indicator).

Main gaps vs best-in-class (Cline/Gemini/Claude):
1. No first-class checkpoint browser with diff preview before restore.
2. No direct `/rewind` command flow equivalent (currently piggybacks mainly on fork/tree).
3. No true per-tool checkpoint cadence (best agents checkpoint around each tool mutation).
4. No built-in redo/unrevert stack across multiple rewind steps.
5. Limited public UX around retention/cleanup/metadata visibility.

---

**Recommendation**

Use **`checkpoint-pi`** as the base today.

If you want Pi to match or exceed the best rewind experience:
1. Fork `checkpoint-pi` and add **per-tool checkpointing** using Pi tool lifecycle events (`tool_execution_start/end`) plus current turn snapshots.
2. Add a **checkpoint browser** command/UI (list, compare diff, restore mode selection).
3. Add **redo/unrevert stack** and clear retention controls.

That path gives you Cline/Gemini-level safety while keeping Pi-native fork/tree conversation semantics.

---

Sources:  
- OpenCode docs/code: `tui.mdx`, `acp.mdx`, `session/revert.ts`, `snapshot/index.ts`, `storage/db.ts`  
  https://github.com/sst/opencode  
- Claude Code rewind docs  
  https://docs.anthropic.com/en/docs/claude-code/interactive-mode#rewind  
  https://docs.anthropic.com/en/docs/claude-code/ide-integrations  
- Codex protocol/TUI/core  
  https://github.com/openai/codex  
- Gemini CLI rewind/checkpointing/docs/code  
  https://github.com/google-gemini/gemini-cli  
- Aider `/undo` + docs  
  https://github.com/Aider-AI/aider  
- Cline checkpoints docs/code  
  https://github.com/cline/cline  
- Crush history/tool/UI/db code  
  https://github.com/charmbracelet/crush  
- Windsurf checkpoints docs  
  https://docs.windsurf.com/windsurf/cascade/cascade  
- Cursor chat checkpoints docs  
  https://docs.cursor.com/chat/overview#revert-checkpoints-and-branch-snapshots  
- Pi extensions + list  
  https://github.com/nicobailon/pi-rewind-hook  
  https://github.com/prateekmedia/pi-hooks/tree/main/checkpoint  
  https://github.com/qualisero/awesome-pi-agent  
- Pi extension API/events (build feasibility)  
  https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
