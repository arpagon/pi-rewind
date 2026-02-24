/**
 * pi-rewind — Extension entry point
 *
 * Automatic git-based checkpoints with per-tool granularity.
 * Creates snapshots of your working tree so you can rewind when the AI makes mistakes.
 *
 * Checkpoint strategy (matches Cline — research-backed):
 *   - 1 resume checkpoint on session start
 *   - 1 checkpoint at turn_end (after ALL tools in a response finish)
 *   - Label: user prompt + list of mutating tools that ran
 *   - No per-tool or per-turn-start checkpoints (noisy, redundant)
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
    // Reset tool list for this new turn
    state.turnToolDescriptions = [];
    state.turnHadMutations = false;
  });

  // ========================================================================
  // Track turn index
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
  // Track mutating tools (accumulate per turn, checkpoint at turn_end)
  // ========================================================================

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!MUTATING_TOOLS.has(event.toolName)) return;

    state.turnHadMutations = true;

    // Get the description captured from tool_call
    const toolDesc = state.pendingToolInfo.get(event.toolCallId)
      || event.toolName;
    state.pendingToolInfo.delete(event.toolCallId);

    state.turnToolDescriptions.push(toolDesc);
  });

  // ========================================================================
  // Create checkpoint at turn_end (1 per model response, like Cline)
  // ========================================================================

  pi.on("turn_end", async (_event, ctx) => {
    if (!ctx.hasUI || !state.gitAvailable || state.failed) return;
    if (!state.repoRoot || !state.sessionId) return;

    // Only create checkpoint if this turn had mutating tools
    if (state.turnHadMutations) {
      // Build description: prompt + tools
      const promptLabel = state.currentPrompt ? `"${state.currentPrompt}"` : "";
      const toolsLabel = state.turnToolDescriptions.join(", ");
      const desc = promptLabel && toolsLabel
        ? `${promptLabel} → ${toolsLabel}`
        : promptLabel || toolsLabel || `Turn ${state.currentTurnIndex}`;

      // Wait for any in-flight checkpoint
      if (state.pending) await state.pending;

      state.pending = (async () => {
        try {
          const ts = Date.now();
          const id = `turn-${state.sessionId}-${state.currentTurnIndex}-${ts}`;
          const cp = await createCheckpoint({
            root: state.repoRoot!,
            id,
            sessionId: state.sessionId!,
            trigger: "tool",
            turnIndex: state.currentTurnIndex,
            description: desc,
          });
          state.checkpoints.set(cp.id, cp);
          updateStatus(state, ctx);
        } catch {
          // Checkpoint failures are non-fatal
        }
      })();
    }

    // Wait for checkpoint to complete before pruning
    if (state.pending) await state.pending;

    // Auto-prune
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
        updateStatus(state, ctx);
      }
    } catch {
      // Pruning is non-critical
    }

    // Reset turn state
    state.turnToolDescriptions = [];
    state.turnHadMutations = false;
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
