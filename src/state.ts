/**
 * pi-rewind — Shared state
 *
 * Mutable state shared between index.ts, commands.ts, and ui.ts.
 */

import type { CheckpointData } from "./core.js";

export interface RewindState {
  /** Is the cwd a git repo? */
  gitAvailable: boolean;
  /** Absolute path to repo root */
  repoRoot: string | null;
  /** Current session ID (UUID) */
  sessionId: string | null;
  /** In-memory checkpoint cache: checkpoint ID → data */
  checkpoints: Map<string, CheckpointData>;
  /** Checkpoint taken at session start (fallback for restore) */
  resumeCheckpoint: CheckpointData | null;
  /** Stack of before-restore checkpoints for undo */
  redoStack: CheckpointData[];
  /** True if checkpoint creation failed (stop retrying) */
  failed: boolean;
  /** Promise of in-flight checkpoint (avoid races) */
  pending: Promise<void> | null;
  /** Current turn index (updated by turn_start) */
  currentTurnIndex: number;
  /** Current user prompt (updated by before_agent_start) */
  currentPrompt: string;
  /** Pending tool info captured from tool_call (before execution ends) */
  pendingToolInfo: Map<string, string>;
  /** Debounce timer for coalescing rapid tool checkpoints */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Tool descriptions accumulated during the debounce window */
  debounceDescriptions: string[];
  /** Cached ctx for the debounce flush */
  debounceCtx: any;
}

export function createInitialState(): RewindState {
  return {
    gitAvailable: false,
    repoRoot: null,
    sessionId: null,
    checkpoints: new Map(),
    resumeCheckpoint: null,
    redoStack: [],
    failed: false,
    pending: null,
    currentTurnIndex: 0,
    currentPrompt: "",
    pendingToolInfo: new Map(),
    debounceTimer: null,
    debounceDescriptions: [],
    debounceCtx: null,
  };
}

export function resetState(state: RewindState): void {
  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  state.gitAvailable = false;
  state.repoRoot = null;
  state.sessionId = null;
  state.checkpoints.clear();
  state.resumeCheckpoint = null;
  state.redoStack = [];
  state.failed = false;
  state.pending = null;
  state.currentTurnIndex = 0;
  state.currentPrompt = "";
  state.pendingToolInfo.clear();
  state.debounceTimer = null;
  state.debounceDescriptions = [];
  state.debounceCtx = null;
}
