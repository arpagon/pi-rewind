/**
 * pi-rewind — /rewind command and Esc+Esc shortcut
 *
 * Registers the user-facing rewind command which presents a checkpoint
 * browser and restore options.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RewindState } from "./state.js";
import type { CheckpointData, RestorePreview } from "./core.js";
import {
  buildRestorePreview,
  createCheckpoint,
  deleteCheckpoint,
  git,
  restoreCheckpoint,
} from "./core.js";

// ============================================================================
// Helpers
// ============================================================================

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatCheckpointLabel(cp: CheckpointData, index: number, _state: RewindState, currentBranch?: string): string {
  const time = formatTimestamp(cp.timestamp);
  const branchTag = (cp.branch && currentBranch && cp.branch !== currentBranch)
    ? ` ⚠️ ${cp.branch}`
    : (cp.branch ? ` [${cp.branch}]` : "");

  if (cp.description) {
    return `#${index + 1} [${time}]${branchTag} ${cp.description}`;
  }

  // Fallback for old checkpoints without description
  if (cp.trigger === "resume") return `#${index + 1} [${time}]${branchTag} Session start`;
  if (cp.trigger === "tool" && cp.toolName) return `#${index + 1} [${time}]${branchTag} → ${cp.toolName}`;
  return `#${index + 1} [${time}]${branchTag} Turn ${cp.turnIndex}`;
}

type RestoreMode = "all" | "files" | "conversation" | "cancel";

const RESTORE_OPTIONS: { label: string; value: RestoreMode }[] = [
  { label: "Restore all (files + conversation)", value: "all" },
  { label: "Files only (keep conversation)", value: "files" },
  { label: "Conversation only (keep files)", value: "conversation" },
  { label: "Cancel", value: "cancel" },
];

function formatRestorePreview(preview: RestorePreview): string {
  const sections: string[] = [];

  if (preview.worktreeDiff) {
    sections.push(`Working tree changes to rewind:\n${preview.worktreeDiff}`);
  }
  if (preview.indexDiff) {
    sections.push(`Staging changes to rewind:\n${preview.indexDiff}`);
  }
  if (preview.untrackedFilesToRemove.length > 0) {
    const shown = preview.untrackedFilesToRemove.slice(0, 50);
    const remaining = preview.untrackedFilesToRemove.length - shown.length;
    const suffix = remaining > 0 ? `\n...and ${remaining} more` : "";
    sections.push(
      `New untracked files to remove (recoverable with undo):\n${shown.join("\n")}${suffix}`,
    );
  }

  return sections.join("\n\n").slice(0, 4000);
}

// ============================================================================
// Rewind flow
// ============================================================================

async function runRewindFlow(
  state: RewindState,
  ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    ctx.ui.notify("Rewind not available (no git repo or session)", "warning");
    return;
  }

  // Collect checkpoints sorted newest-first (limit to 25 most recent)
  const MAX_DISPLAY = 25;
  const checkpoints = [...state.checkpoints.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_DISPLAY);

  if (checkpoints.length === 0) {
    ctx.ui.notify("No checkpoints available", "warning");
    return;
  }

  // Build picker items
  const items: string[] = [];
  const currentBranch = await git("rev-parse --abbrev-ref HEAD", state.repoRoot).catch(() => "unknown");
  const undoRef = state.redoStack.length > 0 ? state.redoStack[state.redoStack.length - 1] : null;
  if (undoRef) {
    items.push("↩ Undo last rewind");
  }
  for (let i = 0; i < checkpoints.length; i++) {
    items.push(formatCheckpointLabel(checkpoints[i], i, state, currentBranch));
  }

  const choice = await ctx.ui.select("Rewind to checkpoint:", items);
  if (!choice) {
    ctx.ui.notify("Rewind cancelled", "info");
    return;
  }

  // Handle undo
  if (choice === "↩ Undo last rewind" && undoRef) {
    const undoIndex = state.redoStack.length - 1;
    const restored = await performRestore(state, ctx, undoRef, "files");
    if (!restored) return;
    state.redoStack.splice(undoIndex, 1);
    ctx.ui.notify("Undo successful — files restored to before last rewind", "info");
    return;
  }

  // Find selected checkpoint
  const idx = items.indexOf(choice) - (undoRef ? 1 : 0);
  if (idx < 0 || idx >= checkpoints.length) return;
  const target = checkpoints[idx];

  // Ask restore mode
  const modeChoice = await ctx.ui.select(
    "Restore mode:",
    RESTORE_OPTIONS.map((o) => o.label),
  );
  const mode = RESTORE_OPTIONS.find((o) => o.label === modeChoice)?.value ?? "cancel";
  if (mode === "cancel") {
    ctx.ui.notify("Rewind cancelled", "info");
    return;
  }

  if (mode === "files" || mode === "all") {
    const restored = await performRestore(state, ctx, target, "files");
    if (!restored) return;
  }

  if (mode === "conversation" || mode === "all") {
    // Navigate conversation tree to the checkpoint's point
    // Find the entry closest to the checkpoint timestamp
    const branch = ctx.sessionManager.getBranch();
    const targetEntry = branch.reduce((best: any, entry: any) => {
      if (!entry.timestamp) return best;
      const entryTs = new Date(entry.timestamp).getTime();
      if (!best) return entryTs <= target.timestamp ? entry : best;
      const bestTs = new Date(best.timestamp).getTime();
      if (entryTs <= target.timestamp && entryTs > bestTs) return entry;
      return best;
    }, null);

    if (targetEntry) {
      try {
        await ctx.navigateTree(targetEntry.id, { summarize: true });
      } catch {
        ctx.ui.notify("Conversation rewind partially failed", "warning");
      }
    }
  }

  const what = mode === "all" ? "files + conversation"
    : mode === "files" ? "files" : "conversation";
  ctx.ui.notify(`Rewound ${what} to checkpoint #${idx + 1}`, "info");
}

type RestoreUI = {
  notify: (msg: string, level: "info" | "warning" | "error") => void;
  confirm: (title: string, message: string) => Promise<boolean>;
};

export interface RestoreDependencies {
  createCheckpoint: typeof createCheckpoint;
  buildRestorePreview: typeof buildRestorePreview;
  restoreCheckpoint: typeof restoreCheckpoint;
  deleteCheckpoint: typeof deleteCheckpoint;
}

const DEFAULT_RESTORE_DEPENDENCIES: RestoreDependencies = {
  createCheckpoint,
  buildRestorePreview,
  restoreCheckpoint,
  deleteCheckpoint,
};

export async function performRestore(
  state: RewindState,
  ctx: { ui: RestoreUI },
  target: CheckpointData,
  _mode: "files",
  dependencies: RestoreDependencies = DEFAULT_RESTORE_DEPENDENCIES,
): Promise<boolean> {
  if (!state.repoRoot || !state.sessionId) return false;

  // Create before-restore checkpoint (safety net)
  let beforeCp: CheckpointData;
  try {
    const beforeId = `before-restore-${state.sessionId}-${Date.now()}`;
    beforeCp = await dependencies.createCheckpoint({
      root: state.repoRoot,
      id: beforeId,
      sessionId: state.sessionId,
      trigger: "before-restore",
      turnIndex: 0,
    });
  } catch (err) {
    ctx.ui.notify(
      `Restore cancelled: safety checkpoint failed: ${err instanceof Error ? err.message : err}`,
      "error",
    );
    return false;
  }

  let preview: RestorePreview;
  try {
    preview = await dependencies.buildRestorePreview(state.repoRoot, target, beforeCp);
  } catch (err) {
    await dependencies.deleteCheckpoint(state.repoRoot, beforeCp.id).catch(() => {});
    ctx.ui.notify(
      `Restore cancelled: preview failed: ${err instanceof Error ? err.message : err}`,
      "error",
    );
    return false;
  }

  const previewText = formatRestorePreview(preview);
  if (previewText) {
    const proceed = await ctx.ui.confirm("Proceed with file restore?", previewText);
    if (!proceed) {
      await dependencies.deleteCheckpoint(state.repoRoot, beforeCp.id).catch(() => {});
      ctx.ui.notify("Rewind cancelled", "info");
      return false;
    }
  }

  // Restore files
  state.redoStack.push(beforeCp);
  try {
    await dependencies.restoreCheckpoint(state.repoRoot, target, {
      skippedLargeFiles: beforeCp.skippedLargeFiles,
      skippedLargeDirs: beforeCp.skippedLargeDirs,
    });
    return true;
  } catch (err) {
    ctx.ui.notify(`Restore failed: ${err instanceof Error ? err.message : err}`, "error");
    return false;
  }
}

// ============================================================================
// Handle fork/tree restore prompts
// ============================================================================

export async function handleForkRestore(
  state: RewindState,
  event: { entryId: string },
  ctx: any,
): Promise<{ cancel: true } | { skipConversationRestore: true } | undefined> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) return undefined;
  if (!ctx.hasUI) return undefined;

  const entry = ctx.sessionManager.getEntry(event.entryId);
  const targetTs = entry?.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

  // Find best checkpoint
  const sorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  const target = sorted.find((cp) => cp.timestamp <= targetTs) ?? sorted[sorted.length - 1];

  if (!target && state.resumeCheckpoint) {
    // Use resume checkpoint as fallback
  }

  const cp = target || state.resumeCheckpoint;

  const options: string[] = ["Conversation only (keep files)"];
  if (cp) {
    options.push("Restore all (files + conversation)");
    options.push("Code only (restore files, keep conversation)");
  }
  if (state.redoStack.length > 0) {
    options.push("↩ Undo last rewind");
  }
  options.push("Cancel");

  const choice = await ctx.ui.select("Restore Options", options);

  if (!choice || choice === "Cancel") return { cancel: true };
  if (choice === "Conversation only (keep files)") return undefined;

  if (choice === "↩ Undo last rewind" && state.redoStack.length > 0) {
    const undoIndex = state.redoStack.length - 1;
    const undoCp = state.redoStack[undoIndex];
    const restored = await performRestore(state, ctx, undoCp, "files");
    if (!restored) return { cancel: true };
    state.redoStack.splice(undoIndex, 1);
    ctx.ui.notify("Files restored to before last rewind", "info");
    return { cancel: true };
  }

  if (!cp) {
    ctx.ui.notify("No checkpoint available", "warning");
    return undefined;
  }

  const restored = await performRestore(state, ctx, cp, "files");
  if (!restored) return { cancel: true };
  ctx.ui.notify("Files restored from checkpoint", "info");

  if (choice === "Code only (restore files, keep conversation)") {
    return { skipConversationRestore: true };
  }

  return undefined;
}

export async function handleTreeRestore(
  state: RewindState,
  event: { preparation: { targetId: string } },
  ctx: any,
): Promise<{ cancel: true } | undefined> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) return undefined;
  if (!ctx.hasUI) return undefined;

  const entry = ctx.sessionManager.getEntry(event.preparation.targetId);
  const targetTs = entry?.timestamp ? new Date(entry.timestamp).getTime() : Date.now();

  const sorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  const cp = sorted.find((c) => c.timestamp <= targetTs) ?? state.resumeCheckpoint;

  const options: string[] = ["Keep current files"];
  if (cp) options.push("Restore files to that point");
  if (state.redoStack.length > 0) options.push("↩ Undo last rewind");
  options.push("Cancel navigation");

  const choice = await ctx.ui.select("Restore Options", options);

  if (!choice || choice === "Cancel navigation") return { cancel: true };
  if (choice === "Keep current files") return undefined;

  if (choice === "↩ Undo last rewind" && state.redoStack.length > 0) {
    const undoIndex = state.redoStack.length - 1;
    const undoCp = state.redoStack[undoIndex];
    const restored = await performRestore(state, ctx, undoCp, "files");
    if (!restored) return { cancel: true };
    state.redoStack.splice(undoIndex, 1);
    ctx.ui.notify("Files restored to before last rewind", "info");
    return { cancel: true };
  }

  if (cp) {
    const restored = await performRestore(state, ctx, cp, "files");
    if (!restored) return { cancel: true };
    ctx.ui.notify("Files restored to checkpoint", "info");
  }

  return undefined;
}

// ============================================================================
// Registration
// ============================================================================

export function registerCommands(pi: ExtensionAPI, state: RewindState): void {
  pi.registerCommand("rewind", {
    description: "Rewind file changes and/or conversation to a checkpoint",
    handler: async (_args, ctx) => {
      await runRewindFlow(state, ctx);
    },
  });

  // Esc+Esc shortcut — register as double-escape
  pi.registerShortcut("escape escape", {
    description: "Rewind (same as /rewind)",
    handler: async (ctx) => {
      // Shortcut handler gets ExtensionContext, not CommandContext.
      // We can't call navigateTree from here, so do files-only quick rewind.
      if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
        ctx.ui.notify("Rewind not available", "warning");
        return;
      }

      const checkpoints = [...state.checkpoints.values()]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 25);

      if (checkpoints.length === 0) {
        ctx.ui.notify("No checkpoints available", "warning");
        return;
      }

      const currentBranch = await git("rev-parse --abbrev-ref HEAD", state.repoRoot).catch(() => "unknown");
      const items = checkpoints.map((cp, i) => formatCheckpointLabel(cp, i, state, currentBranch));
      const choice = await ctx.ui.select("Quick rewind (files only):", items);
      if (!choice) return;

      const idx = items.indexOf(choice);
      if (idx < 0) return;

      const restored = await performRestore(state, { ui: ctx.ui }, checkpoints[idx], "files");
      if (restored) {
        ctx.ui.notify(`Files rewound to checkpoint #${idx + 1}`, "info");
      }
    },
  });
}
