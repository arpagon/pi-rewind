/**
 * pi-rewind — Extension entry point
 *
 * Automatic git-based checkpoints with per-tool granularity.
 * Creates snapshots of your working tree so you can rewind when the AI makes mistakes.
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

export default function (pi: ExtensionAPI) {
  const state = createInitialState();

  // Register /rewind command and Esc+Esc shortcut
  registerCommands(pi, state);

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
    // Update session ID after fork
    state.sessionId = ctx.sessionManager.getSessionId();
  });

  // ========================================================================
  // Per-turn checkpointing
  // ========================================================================

  pi.on("turn_start", async (event, ctx) => {
    if (!ctx.hasUI || !state.gitAvailable || state.failed) return;
    if (!state.repoRoot || !state.sessionId) return;

    state.pending = (async () => {
      try {
        const id = `turn-${state.sessionId}-${event.turnIndex}-${event.timestamp}`;
        const cp = await createCheckpoint({
          root: state.repoRoot!,
          id,
          sessionId: state.sessionId!,
          trigger: "turn",
          turnIndex: event.turnIndex,
        });
        state.checkpoints.set(cp.id, cp);
        updateStatus(state, ctx);
      } catch {
        state.failed = true;
      }
    })();
  });

  // ========================================================================
  // Per-tool checkpointing (after each write/edit/bash)
  // ========================================================================

  pi.on("tool_execution_end", async (event, ctx) => {
    if (!ctx.hasUI || !state.gitAvailable || state.failed) return;
    if (!state.repoRoot || !state.sessionId) return;
    if (!MUTATING_TOOLS.has(event.toolName)) return;

    // Wait for any pending turn checkpoint first
    if (state.pending) await state.pending;

    state.pending = (async () => {
      try {
        const ts = Date.now();
        const id = `tool-${state.sessionId}-${sanitizeForRef(event.toolCallId)}-${ts}`;
        const cp = await createCheckpoint({
          root: state.repoRoot!,
          id,
          sessionId: state.sessionId!,
          trigger: "tool",
          turnIndex: -1, // Unknown at this point
          toolName: event.toolName,
        });
        state.checkpoints.set(cp.id, cp);
        updateStatus(state, ctx);
      } catch {
        // Don't set failed for tool checkpoints — transient errors are OK
      }
    })();
  });

  // ========================================================================
  // Auto-pruning at turn end
  // ========================================================================

  pi.on("turn_end", async (_event, _ctx) => {
    if (!state.gitAvailable || !state.repoRoot || !state.sessionId) return;

    // Wait for pending checkpoint
    if (state.pending) await state.pending;

    try {
      const pruned = await pruneCheckpoints(
        state.repoRoot,
        state.sessionId,
        DEFAULT_MAX_CHECKPOINTS,
      );
      if (pruned > 0) {
        // Rebuild in-memory cache after pruning
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
    // Ensure pending checkpoints complete
    if (state.pending) await state.pending;
  });
}
