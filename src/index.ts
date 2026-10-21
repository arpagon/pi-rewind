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

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  deleteCheckpoint,
  loadAllCheckpoints,
  pruneCheckpoints,
  pruneOldSessions,
  isMutatingTool,
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

/**
 * omp-only events. pi's published typings do not declare them and omp is not a
 * dependency, so type exactly the surface this extension consumes.
 */
type OmpEvents = {
  on(
    event: "session_switch",
    handler: (event: { reason: "new" | "resume" | "fork" }, ctx: ExtensionContext) => Promise<void> | void,
  ): void;
  on(
    event: "session_before_branch",
    handler: (
      event: { entryId: string },
      ctx: ExtensionContext,
    ) => Promise<{ cancel: true } | { skipConversationRestore: true } | undefined>,
  ): void;
};

/** Extract a human-readable description from a tool_call event */
function describeToolCall(toolName: string, input: any): string {
  if (!input) return toolName;
  switch (toolName) {
    case "write":
      return `write → ${input.path || "?"}`;
    case "edit":
      return `edit → ${input.path || "?"}`;
    case "ast_edit":
      return `ast_edit → ${truncate(String(input.paths ?? "?"), 50)}`;
    case "bash":
      return `bash: ${truncate(String(input.command || ""), 50)}`;
    default:
      return toolName;
  }
}

export default function (pi: ExtensionAPI) {
  const state = createInitialState();
  // omp injects a `logger` into the extension API; pi does not.
  const isOmp = "logger" in pi;
  const omp = pi as unknown as OmpEvents;

  registerCommands(pi, state);

  // ========================================================================
  // Session lifecycle
  // ========================================================================

  let pendingTreeTargetId: string | null = null;
  // Bumped whenever a deferred tree prompt must be abandoned.
  let treeRestoreSeq = 0;

  async function initSession(ctx: ExtensionContext): Promise<void> {
    // omp can emit session_start and session_switch for the same session.
    if (state.sessionId === ctx.sessionManager.getSessionId() && state.resumeCheckpoint) return;
    resetState(state);
    pendingTreeTargetId = null;
    treeRestoreSeq++;

    state.gitAvailable = await isGitRepo(ctx.cwd);
    if (!state.gitAvailable) {
      if (ctx.hasUI) clearStatus(ctx);
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
      state.lastWorktreeTree = cp.worktreeTreeSha;
    } catch {
      // Resume checkpoint is optional
    }

    if (ctx.hasUI) updateStatus(state, ctx);

    // Prune old sessions in background (non-blocking)
    if (state.repoRoot && state.sessionId) {
      const root = state.repoRoot;
      const sid = state.sessionId;
      pruneOldSessions(root, sid).then((pruned) => {
        if (pruned > 0) {
          // Reload cache after prune
          loadAllCheckpoints(root, sid).then((remaining) => {
            state.checkpoints.clear();
            for (const cp of remaining) state.checkpoints.set(cp.id, cp);
            if (ctx.hasUI) updateStatus(state, ctx);
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  }

  pi.on("session_start", async (event, ctx) => {
    // A fork keeps the parent's checkpoints: the new session file has no refs,
    // so re-initializing would wipe history, the undo stack, and prune the
    // parent session's refs in the background.
    if (event.reason === "fork") {
      if (state.gitAvailable) state.sessionId = ctx.sessionManager.getSessionId();
      return;
    }
    await initSession(ctx);
  });

  // omp emits session_switch (not session_start) for new/resume/fork; skip the
  // startup switch that follows session_start for the same session.
  omp.on("session_switch", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId === state.sessionId) return;
    if (event.reason === "fork" && state.gitAvailable) {
      state.sessionId = sessionId;
      return;
    }
    await initSession(ctx);
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
    if (isMutatingTool(event.toolName)) {
      const desc = describeToolCall(event.toolName, event.input);
      state.pendingToolInfo.set(event.toolCallId, desc);
    }
  });

  // ========================================================================
  // Track mutating tools (accumulate per turn, checkpoint at turn_end)
  // ========================================================================

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (!isMutatingTool(event.toolName)) return;

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
    if (!state.gitAvailable || state.failed) return;
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

          // Skip if worktree is identical to last checkpoint (read-only bash like ls, find, cat)
          if (state.lastWorktreeTree && cp.worktreeTreeSha === state.lastWorktreeTree) {
            await deleteCheckpoint(state.repoRoot!, cp.id);
            return;
          }

          state.checkpoints.set(cp.id, cp);
          state.lastWorktreeTree = cp.worktreeTreeSha;
          if (ctx.hasUI) updateStatus(state, ctx);
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
        if (ctx.hasUI) updateStatus(state, ctx);
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

  // Pi emits session_before_fork; omp emits session_before_branch instead.
  // Register both so each host sees the restore prompt.
  pi.on("session_before_fork", async (event, ctx) => {
    return handleForkRestore(state, event, ctx);
  });

  omp.on("session_before_branch", async (event, ctx) => {
    return handleForkRestore(state, event, ctx);
  });

  pi.on("session_before_tree", async (event, ctx) => {
    const targetId = event.preparation.targetId;
    if (targetId === state.suppressTreeRestoreTarget) {
      state.suppressTreeRestoreTarget = null;
      return;
    }
    // Pi can prompt before navigating and cancel the navigation; omp's
    // fullscreen rewind overlay hides dialogs opened here, so defer the prompt
    // until session_tree fires (see handleTreeRestore).
    if (!isOmp) return handleTreeRestore(state, targetId, ctx, true);
    pendingTreeTargetId = targetId;
  });

  pi.on("session_tree", async (_event, ctx) => {
    const targetId = pendingTreeTargetId;
    pendingTreeTargetId = null;
    if (!targetId) return;
    // A later navigation or session switch invalidates this prompt.
    const seq = ++treeRestoreSeq;
    setTimeout(() => {
      if (seq !== treeRestoreSeq) return;
      void handleTreeRestore(state, targetId, ctx, false);
    }, 50);
  });

  // ========================================================================
  // Shutdown
  // ========================================================================

  pi.on("session_shutdown", async () => {
    if (state.pending) await state.pending;
  });
}
