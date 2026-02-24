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
  // Capture tool args for checkpoint labels
  // ========================================================================

  pi.on("tool_call", async (event, _ctx) => {
    if (MUTATING_TOOLS.has(event.toolName)) {
      const desc = describeToolCall(event.toolName, event.input);
      state.pendingToolInfo.set(event.toolCallId, desc);
    }
  });

  // ========================================================================
  // Per-turn checkpointing
  // ========================================================================

  pi.on("turn_start", async (event, ctx) => {
    if (!ctx.hasUI || !state.gitAvailable || state.failed) return;
    if (!state.repoRoot || !state.sessionId) return;

    state.currentTurnIndex = event.turnIndex;

    state.pending = (async () => {
      try {
        const id = `turn-${state.sessionId}-${event.turnIndex}-${event.timestamp}`;
        const desc = state.currentPrompt
          ? `"${state.currentPrompt}"`
          : `Turn ${event.turnIndex}`;
        const cp = await createCheckpoint({
          root: state.repoRoot!,
          id,
          sessionId: state.sessionId!,
          trigger: "turn",
          turnIndex: event.turnIndex,
          description: desc,
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

    // Get the description captured from tool_call
    const toolDesc = state.pendingToolInfo.get(event.toolCallId)
      || `${event.toolName}`;
    state.pendingToolInfo.delete(event.toolCallId);

    state.pending = (async () => {
      try {
        const ts = Date.now();
        const id = `tool-${state.sessionId}-${sanitizeForRef(event.toolCallId)}-${ts}`;
        const cp = await createCheckpoint({
          root: state.repoRoot!,
          id,
          sessionId: state.sessionId!,
          trigger: "tool",
          turnIndex: state.currentTurnIndex,
          toolName: event.toolName,
          description: `→ ${toolDesc}`,
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
    if (state.pending) await state.pending;
  });
}
