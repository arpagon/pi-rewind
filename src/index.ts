/**
 * pi-rewind — Extension entry point
 *
 * Automatic git-based checkpoints with per-tool granularity.
 * Creates snapshots of your working tree so you can rewind when the AI makes mistakes.
 *
 * Checkpoint strategy (inspired by Cline & OpenCode research):
 *   - 1 resume checkpoint on session start
 *   - 1 debounced checkpoint per burst of mutating tools (write/edit/bash)
 *   - Debounce window: 2s — rapid tools coalesce into a single snapshot
 *   - Flush any pending checkpoint at turn_end
 *   - No per-turn checkpoints (redundant with tool checkpoints)
 *
 * Usage:
 *   pi -e ./src/index.ts
 *   pi install github.com/arpagon/pi-rewind
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  loadAllCheckpoints,
  pruneCheckpoints,
  sanitizeForRef,
  MUTATING_TOOLS,
  DEFAULT_MAX_CHECKPOINTS,
} from "./core.js";
import { createInitialState, resetState } from "./state.js";
import { updateStatus, clearStatus } from "./ui.js";
import { registerCommands, handleForkRestore, handleTreeRestore } from "./commands.js";

/** Debounce window in ms — tools firing within this window coalesce */
const DEBOUNCE_MS = 2000;

/** Truncate a string to maxLen, adding ellipsis if needed */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/** Extract a human-readable description from a tool_call event */
function describeToolCall(toolName: string, input: any): string {
  if (!input) return toolName;
  switch (toolName) {
    case "write":
      return `write → ${input.path || "?"}`;
    case "edit":
      return `edit → ${input.path || "?"}`;
    case "bash":
      return `bash: ${truncate(String(input.command || ""), 50)}`;
    default:
      return toolName;
  }
}

export default function (pi: ExtensionAPI) {
  const state = createInitialState();

  // Register /rewind command and Esc+Esc shortcut
  registerCommands(pi, state);

  // ========================================================================
  // Debounced checkpoint creation
  // ========================================================================

  /**
   * Flush the debounce buffer — creates one checkpoint with all accumulated
   * tool descriptions since the last checkpoint.
   */
  async function flushDebounce(): Promise<void> {
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }

    const descriptions = state.debounceDescriptions.splice(0);
    const ctx = state.debounceCtx;
    if (descriptions.length === 0) return;
    if (!state.repoRoot || !state.sessionId) return;

    // Wait for any in-flight checkpoint
    if (state.pending) await state.pending;

    // Build description: show prompt + tool list
    const promptLabel = state.currentPrompt ? `"${state.currentPrompt}"` : "";
    const toolsLabel = descriptions.join(", ");
    const desc = promptLabel
      ? `${promptLabel} → ${toolsLabel}`
      : toolsLabel;

    state.pending = (async () => {
      try {
        const ts = Date.now();
        const id = `tool-${state.sessionId}-${ts}`;
        const cp = await createCheckpoint({
          root: state.repoRoot!,
          id,
          sessionId: state.sessionId!,
          trigger: "tool",
          turnIndex: state.currentTurnIndex,
          description: desc,
        });
        state.checkpoints.set(cp.id, cp);
        if (ctx) updateStatus(state, ctx);
      } catch {
        // Tool checkpoint failures are non-fatal
      }
    })();
  }

  /**
   * Schedule a debounced checkpoint. Accumulates tool descriptions and
   * creates one checkpoint when the burst of tools settles.
   */
  function scheduleCheckpoint(toolDesc: string, ctx: any): void {
    state.debounceDescriptions.push(toolDesc);
    state.debounceCtx = ctx;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => flushDebounce(), DEBOUNCE_MS);
  }

  // ========================================================================
  // Session lifecycle
  // ========================================================================

  async function initSession(ctx: any): Promise<void> {
    resetState(state);

    if (!ctx.hasUI) return;

    state.gitAvailable = await isGitRepo(ctx.cwd);
    if (!state.gitAvailable) {
      clearStatus(ctx);
      return;
    }

    state.repoRoot = await getRepoRoot(ctx.cwd);
    state.sessionId = ctx.sessionManager.getSessionId();

    // Rebuild checkpoint cache from existing git refs (for resumed sessions)
    try {
      const existing = await loadAllCheckpoints(state.repoRoot, state.sessionId);
      for (const cp of existing) {
        state.checkpoints.set(cp.id, cp);
      }
    } catch {
      // Silent — we'll create new checkpoints anyway
    }

    // Create resume checkpoint (snapshot of current state on session start)
    try {
      const resumeId = `resume-${state.sessionId}-${Date.now()}`;
      const cp = await createCheckpoint({
        root: state.repoRoot,
        id: resumeId,
        sessionId: state.sessionId,
        trigger: "resume",
        turnIndex: 0,
        description: "Session start",
      });
      state.resumeCheckpoint = cp;
      state.checkpoints.set(cp.id, cp);
    } catch {
      // Resume checkpoint is optional
    }

    updateStatus(state, ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await initSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    await initSession(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    if (!state.gitAvailable) return;
    state.sessionId = ctx.sessionManager.getSessionId();
  });

  // ========================================================================
  // Capture user prompt for checkpoint labels
  // ========================================================================

  pi.on("before_agent_start", async (event, _ctx) => {
    state.currentPrompt = truncate(String(event.prompt || ""), 60);
  });

  // ========================================================================
  // Track turn index (no checkpoint — just bookkeeping)
  // ========================================================================

  pi.on("turn_start", async (event, _ctx) => {
    state.currentTurnIndex = event.turnIndex;
  });

  // ========================================================================
  // Capture tool args for checkpoint labels
  // ========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    if (MUTATING_TOOLS.has(event.toolName)) {
      const desc = describeToolCall(event.toolName, event.input);
      state.pendingToolInfo.set(event.toolCallId, desc);
    }
  });

  // ========================================================================
  // Per-tool checkpointing (debounced — coalesces rapid tool bursts)
  // ========================================================================

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!ctx.hasUI || !state.gitAvailable || state.failed) return;
    if (!state.repoRoot || !state.sessionId) return;
    if (!MUTATING_TOOLS.has(event.toolName)) return;

    // Get the description captured from tool_call
    const toolDesc = state.pendingToolInfo.get(event.toolCallId)
      || event.toolName;
    state.pendingToolInfo.delete(event.toolCallId);

    scheduleCheckpoint(toolDesc, ctx);
  });

  // ========================================================================
  // Flush + auto-prune at turn end
  // ========================================================================

  pi.on("turn_end", async (_event, _ctx) => {
    if (!state.gitAvailable || !state.repoRoot || !state.sessionId) return;

    // Flush any pending debounced checkpoint
    await flushDebounce();

    // Wait for in-flight checkpoint
    if (state.pending) await state.pending;

    try {
      const pruned = await pruneCheckpoints(
        state.repoRoot,
        state.sessionId,
        DEFAULT_MAX_CHECKPOINTS,
      );
      if (pruned > 0) {
        const remaining = await loadAllCheckpoints(state.repoRoot, state.sessionId);
        state.checkpoints.clear();
        for (const cp of remaining) {
          state.checkpoints.set(cp.id, cp);
        }
      }
    } catch {
      // Pruning is non-critical
    }
  });

  // ========================================================================
  // Fork / tree restore hooks
  // ========================================================================

  pi.on("session_before_fork", async (event, ctx) => {
    return handleForkRestore(state, event, ctx);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    return handleTreeRestore(state, event, ctx);
  });

  // ========================================================================
  // Shutdown
  // ========================================================================

  pi.on("session_shutdown", async () => {
    await flushDebounce();
    if (state.pending) await state.pending;
  });
}
