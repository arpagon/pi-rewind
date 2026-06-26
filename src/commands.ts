/**
 * pi-rewind — /rewind command, /rewind cleanup, and Esc+Esc shortcut
 *
 * Registers user-facing commands: checkpoint browser, cleanup, and quick rewind.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RewindState } from "./state.js";
import type { CheckpointData } from "./core.js";
import {
  restoreCheckpoint,
  createCheckpoint,
  diffCheckpoints,
  getCheckpointStats,
  pruneCheckpoints,
  pruneAllOldSessions,
  loadAllCheckpoints,
  git,
} from "./core.js";
import { saveConfig, type RewindConfig } from "./config.js";

// Helpers

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatDateLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - ts) / 86400000);

  if (diffDays === 0) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `Today ${hh}:${mm}`;
  }
  if (diffDays === 1) {
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `Yesterday ${hh}:${mm}`;
  }
  const mon = d.toLocaleString("en", { month: "short" });
  const day = d.getDate();
  return `${mon} ${day}`;
}

function formatCheckpointLabel(cp: CheckpointData, index: number, currentBranch?: string): string {
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

function formatSessionLabel(
  sessionId: string,
  count: number,
  newestTs: number,
  currentSessionId: string | null,
  index: number,
): string {
  const dateLabel = formatDateLabel(newestTs);
  const isCurrent = sessionId === currentSessionId;
  const marker = isCurrent ? " (current)" : "";
  return `${dateLabel} — ${count} checkpoint${count === 1 ? "" : "s"}${marker}`;
}

// Session picker (step 1 of cross-session rewind)

interface SessionGroup {
  sessionId: string;
  checkpoints: CheckpointData[];
  newestTimestamp: number;
}

async function pickSessionAndCheckpoint(
  state: RewindState,
  ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
  currentBranch: string,
): Promise<CheckpointData | null> {
  // Load all checkpoints regardless of session
  let allCheckpoints: CheckpointData[];
  try {
    allCheckpoints = await loadAllCheckpoints(state.repoRoot!);
  } catch {
    ctx.ui.notify("Failed to load checkpoints", "error");
    return null;
  }

  if (allCheckpoints.length === 0) {
    ctx.ui.notify("No checkpoints available", "warning");
    return null;
  }

  // Group by session
  const bySession = new Map<string, CheckpointData[]>();
  for (const cp of allCheckpoints) {
    const list = bySession.get(cp.sessionId) || [];
    list.push(cp);
    bySession.set(cp.sessionId, list);
  }

  // Build session groups sorted newest-first
  const sessionGroups: SessionGroup[] = [];
  for (const [sid, cps] of bySession) {
    cps.sort((a, b) => b.timestamp - a.timestamp);
    sessionGroups.push({
      sessionId: sid,
      checkpoints: cps,
      newestTimestamp: cps[0].timestamp,
    });
  }
  sessionGroups.sort((a, b) => b.newestTimestamp - a.newestTimestamp);

  // Build session picker items
  const sessionItems: string[] = [];
  for (let i = 0; i < sessionGroups.length; i++) {
    const g = sessionGroups[i];
    sessionItems.push(formatSessionLabel(g.sessionId, g.checkpoints.length, g.newestTimestamp, state.sessionId, i));
  }

  const sessionChoice = await ctx.ui.select("Which session?", sessionItems);
  if (!sessionChoice) return null;

  const sessionIdx = sessionItems.indexOf(sessionChoice);
  if (sessionIdx < 0 || sessionIdx >= sessionGroups.length) return null;

  const selectedGroup = sessionGroups[sessionIdx];

  // Now show checkpoint picker for the selected session
  const MAX_DISPLAY = 25;
  const display = selectedGroup.checkpoints.slice(0, MAX_DISPLAY);

  const checkpointItems = display.map((cp, i) => formatCheckpointLabel(cp, i, currentBranch));
  const choice = await ctx.ui.select("Which checkpoint?", checkpointItems);
  if (!choice) return null;

  const cpIdx = checkpointItems.indexOf(choice);
  if (cpIdx < 0 || cpIdx >= display.length) return null;

  return display[cpIdx];
}

// Cleanup command

async function runCleanupFlow(
  state: RewindState,
  ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    ctx.ui.notify("Cleanup not available (no git repo or session)", "warning");
    return;
  }

  let stats;
  try {
    stats = await getCheckpointStats(state.repoRoot, state.sessionId);
  } catch {
    ctx.ui.notify("Failed to collect checkpoint stats", "error");
    return;
  }

  const totalStr = [
    stats.currentSessionCount > 0
      ? `Current session: ${stats.currentSessionCount} checkpoint${stats.currentSessionCount === 1 ? "" : "s"}`
      : null,
    stats.oldSessionsCount > 0
      ? `Old sessions (${stats.oldSessionCount}): ${stats.oldSessionsCount} checkpoint${stats.oldSessionsCount === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean).join("\n");

  const header = stats.total > 0
    ? `📊 Checkpoint stats:\n${totalStr}\nTotal: ${stats.total}`
    : "📊 No checkpoints to clean up.";

  // Build cleanup options
  const options: Array<{ label: string; value: string }> = [];

  if (stats.oldSessionsCount > 0) {
    options.push({
      label: `Prune all old sessions (delete ${stats.oldSessionsCount} checkpoint${stats.oldSessionsCount === 1 ? "" : "s"})`,
      value: "prune-old",
    });
  }

  const maxCp = state.config.maxCheckpoints;
  if (maxCp > 0 && stats.currentSessionCount > maxCp) {
    options.push({
      label: `Prune current session to keep last ${maxCp} (delete ${stats.currentSessionCount - maxCp})`,
      value: "prune-current",
    });
  }

  if (options.length === 0) {
    ctx.ui.notify("Nothing to clean up", "info");
    return;
  }

  options.push({ label: "Cancel", value: "cancel" });

  const choice = await ctx.ui.select(header, options.map((o) => o.label));
  if (!choice) return;

  const action = options.find((o) => o.label === choice)?.value;
  if (!action || action === "cancel") {
    ctx.ui.notify("Cleanup cancelled", "info");
    return;
  }

  if (action === "prune-old") {
    try {
      const deleted = await pruneAllOldSessions(state.repoRoot, state.sessionId);
      ctx.ui.notify(`Deleted ${deleted} checkpoint${deleted === 1 ? "" : "s"} from old sessions`, "info");
    } catch {
      ctx.ui.notify("Cleanup failed", "error");
      return;
    }
  } else if (action === "prune-current") {
    try {
      const deleted = await pruneCheckpoints(state.repoRoot, state.sessionId, maxCp);
      ctx.ui.notify(`Pruned ${deleted} checkpoint${deleted === 1 ? "" : "s"} from current session`, "info");
    } catch {
      ctx.ui.notify("Cleanup failed", "error");
      return;
    }
  }

  // Reload checkpoint cache
  try {
    const remaining = state.config.keepOldSessions
      ? await loadAllCheckpoints(state.repoRoot)
      : await loadAllCheckpoints(state.repoRoot, state.sessionId);
    state.checkpoints.clear();
    for (const cp of remaining) {
      state.checkpoints.set(cp.id, cp);
    }
    if (ctx.hasUI) {
      const { updateStatus } = await import("./ui.js");
      updateStatus(state, ctx);
    }
  } catch { /* cache reload is best-effort */ }
}

// Restore mode

type RestoreMode = "all" | "files" | "conversation" | "cancel";

const RESTORE_OPTIONS: { label: string; value: RestoreMode }[] = [
  { label: "Restore all (files + conversation)", value: "all" },
  { label: "Files only (keep conversation)", value: "files" },
  { label: "Conversation only (keep files)", value: "conversation" },
  { label: "Cancel", value: "cancel" },
];

// Rewind flow

async function runRewindFlow(
  state: RewindState,
  ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
): Promise<void> {
  if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
    ctx.ui.notify("Rewind not available (no git repo or session)", "warning");
    return;
  }

  const currentBranch = await git("rev-parse --abbrev-ref HEAD", state.repoRoot).catch(() => "unknown");

  // Determine if we need cross-session picker
  const useCrossSession = state.config.keepOldSessions;

  let target: CheckpointData | null;

  if (useCrossSession) {
    target = await pickSessionAndCheckpoint(state, ctx, currentBranch);
    if (!target) {
      ctx.ui.notify("Rewind cancelled", "info");
      return;
    }
  } else {
    // Current session only — existing behavior
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
    const undoRef = state.redoStack.length > 0 ? state.redoStack[state.redoStack.length - 1] : null;
    if (undoRef) {
      items.push("↩ Undo last rewind");
    }
    for (let i = 0; i < checkpoints.length; i++) {
      items.push(formatCheckpointLabel(checkpoints[i], i, currentBranch));
    }

    const choice = await ctx.ui.select("Rewind to checkpoint:", items);
    if (!choice) {
      ctx.ui.notify("Rewind cancelled", "info");
      return;
    }

    // Handle undo
    if (choice === "↩ Undo last rewind" && undoRef) {
      await performRestore(state, ctx, undoRef, "files");
      state.redoStack.pop();
      ctx.ui.notify("Undo successful — files restored to before last rewind", "info");
      return;
    }

    // Find selected checkpoint
    const idx = items.indexOf(choice) - (undoRef ? 1 : 0);
    if (idx < 0 || idx >= checkpoints.length) return;
    target = checkpoints[idx];
  }

  if (!target) return;

  // Find index for display (for notification messages)
  const allSorted = [...state.checkpoints.values()].sort((a, b) => b.timestamp - a.timestamp);
  const displayIdx = allSorted.findIndex((cp) => cp.id === target.id);

  // Show diff preview
  let diffText = "";
  try {
    const diff = await diffCheckpoints(state.repoRoot, target.worktreeTreeSha, "HEAD");
    if (diff && diff !== "(diff unavailable)") {
      diffText = diff.slice(0, 2000);
    }
  } catch {
    // Continue without preview if diff fails
  }

  if (diffText) {
    const proceed = await ctx.ui.confirm(
      `Files changed since checkpoint:\n\n${diffText}`,
      "Proceed with restore?",
    );
    if (!proceed) {
      ctx.ui.notify("Rewind cancelled", "info");
      return;
    }
  }

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
    await performRestore(state, ctx, target, "files");
  }

  if (mode === "conversation" || mode === "all") {
    // Navigate conversation tree to the checkpoint's point
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
  const msg = displayIdx >= 0
    ? `Rewound ${what} to checkpoint #${displayIdx + 1}`
    : `Rewound ${what} to checkpoint`;
  ctx.ui.notify(msg, "info");
}

async function performRestore(
  state: RewindState,
  ctx: { ui: { notify: (msg: string, level: "info" | "warning" | "error") => void } },
  target: CheckpointData,
  _mode: "files",
): Promise<void> {
  if (!state.repoRoot || !state.sessionId) return;

  // Create before-restore checkpoint (safety net)
  try {
    const beforeId = `before-restore-${state.sessionId}-${Date.now()}`;
    const beforeCp = await createCheckpoint({
      root: state.repoRoot,
      id: beforeId,
      sessionId: state.sessionId,
      trigger: "before-restore",
      turnIndex: 0,
    });
    state.redoStack.push(beforeCp);
  } catch {
    // Continue anyway — we tried
  }

  // Restore files
  try {
    await restoreCheckpoint(state.repoRoot, target);
  } catch (err) {
    ctx.ui.notify(`Restore failed: ${err instanceof Error ? err.message : err}`, "error");
  }
}

// Handle fork/tree restore prompts

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
    const undoCp = state.redoStack.pop()!;
    await performRestore(state, ctx, undoCp, "files");
    ctx.ui.notify("Files restored to before last rewind", "info");
    return { cancel: true };
  }

  if (!cp) {
    ctx.ui.notify("No checkpoint available", "warning");
    return undefined;
  }

  await performRestore(state, ctx, cp, "files");
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
    const undoCp = state.redoStack.pop()!;
    await performRestore(state, ctx, undoCp, "files");
    ctx.ui.notify("Files restored to before last rewind", "info");
    return { cancel: true };
  }

  if (cp) {
    await performRestore(state, ctx, cp, "files");
    ctx.ui.notify("Files restored to checkpoint", "info");
  }

  return undefined;
}

// ============================================================================
// Settings
// ============================================================================

function formatConfigForDisplay(c: RewindConfig): string[] {
  return [
    `maxCheckpoints = ${c.maxCheckpoints === 0 ? "unlimited" : c.maxCheckpoints}`,
    `keepOldSessions = ${c.keepOldSessions}`,
    `cleanupHintThreshold = ${c.cleanupHintThreshold}`,
  ];
}

async function runSettingsFlow(
  state: RewindState,
  ctx: import("@mariozechner/pi-coding-agent").ExtensionCommandContext,
): Promise<void> {
  // Show current config and let user pick a setting to change (auto-saves on change)
  while (true) {
    const current = formatConfigForDisplay(state.config);
    const options = [
      `maxCheckpoints — ${current[0]}`,
      `keepOldSessions — ${current[1]}`,
      `cleanupHintThreshold — ${current[2]}`,
    ];

    const choice = await ctx.ui.select("Rewind settings:", options);
    if (!choice) {
      ctx.ui.notify("Settings closed", "info");
      return;
    }

    let changed = false;

    if (choice === options[0]) {
      // maxCheckpoints
      const raw = await ctx.ui.input(
        "Max checkpoints per session (0 = unlimited):",
        String(state.config.maxCheckpoints),
      );
      if (raw !== undefined && raw !== null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 0) {
          state.config.maxCheckpoints = n;
          changed = true;
        } else {
          ctx.ui.notify("Invalid number — must be 0 or greater", "warning");
        }
      }
    } else if (choice === options[1]) {
      // keepOldSessions
      const boolChoice = await ctx.ui.select(
        "Keep checkpoints from old sessions?",
        ["Yes (keep all old sessions)", "No (prune on session start)"],
      );
      if (boolChoice) {
        state.config.keepOldSessions = boolChoice.startsWith("Yes");
        changed = true;
      }
    } else if (choice === options[2]) {
      // cleanupHintThreshold
      const raw = await ctx.ui.input(
        "Hint threshold (show cleanup hint when checkpoints exceed):",
        String(state.config.cleanupHintThreshold),
      );
      if (raw !== undefined && raw !== null) {
        const n = parseInt(raw, 10);
        if (!isNaN(n) && n >= 0) {
          state.config.cleanupHintThreshold = n;
          changed = true;
        } else {
          ctx.ui.notify("Invalid number — must be 0 or greater", "warning");
        }
      }
    }

    if (changed) {
      saveConfig(state.config);
      // Reload checkpoint cache, and prune old sessions if keepOldSessions was toggled off
      if (state.repoRoot && state.sessionId) {
        try {
          const remaining = state.config.keepOldSessions
            ? await loadAllCheckpoints(state.repoRoot)
            : await loadAllCheckpoints(state.repoRoot, state.sessionId);
          state.checkpoints.clear();
          for (const cp of remaining) state.checkpoints.set(cp.id, cp);

          // Prune old session refs immediately when toggled off
          if (!state.config.keepOldSessions) {
            const pruned = await pruneAllOldSessions(state.repoRoot, state.sessionId);
            if (pruned > 0 && ctx.hasUI) {
              ctx.ui.notify(
                `Pruned ${pruned} checkpoint${pruned === 1 ? "" : "s"} from old sessions`,
                "info",
              );
            }
          }

          if (ctx.hasUI) {
            const { updateStatus } = await import("./ui.js");
            updateStatus(state, ctx);
          }
        } catch { /* best-effort */ }
      }
    }
  }
}

// Registration

export function registerCommands(pi: ExtensionAPI, state: RewindState): void {
  // /rewind command
  pi.registerCommand("rewind", {
    description: "Rewind file changes and/or conversation to a checkpoint",
    handler: async (_args, ctx) => {
      await runRewindFlow(state, ctx);
    },
  });

  // /rewind-cleanup command
  pi.registerCommand("rewind-cleanup", {
    description: "View stats and prune old checkpoints",
    handler: async (_args, ctx) => {
      await runCleanupFlow(state, ctx);
    },
  });

  // /rewind-settings command
  pi.registerCommand("rewind-settings", {
    description: "Configure rewind checkpoint settings",
    handler: async (_args, ctx) => {
      await runSettingsFlow(state, ctx);
    },
  });

  // Esc+Esc shortcut — files-only quick rewind
  pi.registerShortcut("escape escape", {
    description: "Rewind (same as /rewind)",
    handler: async (ctx) => {
      if (!state.gitAvailable || !state.repoRoot || !state.sessionId) {
        ctx.ui.notify("Rewind not available", "warning");
        return;
      }

      const currentBranch = await git("rev-parse --abbrev-ref HEAD", state.repoRoot).catch(() => "unknown");

      let target: CheckpointData | null;

      if (state.config.keepOldSessions) {
        // Quick rewind with cross-session: pick from last 2 sessions only
        let allCheckpoints: CheckpointData[];
        try {
          allCheckpoints = await loadAllCheckpoints(state.repoRoot);
        } catch {
          ctx.ui.notify("Failed to load checkpoints", "error");
          return;
        }

        if (allCheckpoints.length === 0) {
          ctx.ui.notify("No checkpoints available", "warning");
          return;
        }

        // Group by session, take current + 1 most recent old session
        const bySession = new Map<string, CheckpointData[]>();
        for (const cp of allCheckpoints) {
          const list = bySession.get(cp.sessionId) || [];
          list.push(cp);
          bySession.set(cp.sessionId, list);
        }

        const groups = [...bySession.entries()]
          .map(([sid, cps]) => {
            cps.sort((a, b) => b.timestamp - a.timestamp);
            return { sessionId: sid, checkpoints: cps, newest: cps[0].timestamp };
          })
          .sort((a, b) => b.newest - a.newest);

        // Take current + 1 most recent old
        const current = groups.find((g) => g.sessionId === state.sessionId);
        const recentOld = groups.filter((g) => g.sessionId !== state.sessionId).slice(0, 1);
        const relevant = [current, ...recentOld].filter(Boolean).flatMap((g) => g!.checkpoints);
        relevant.sort((a, b) => b.timestamp - a.timestamp);

        const MAX_QUICK = 20;
        const display = relevant.slice(0, MAX_QUICK);
        const items = display.map((cp, i) => formatCheckpointLabel(cp, i, currentBranch));
        const choice = await ctx.ui.select("Quick rewind (files only):", items);
        if (!choice) return;

        const idx = items.indexOf(choice);
        if (idx < 0) return;
        target = display[idx];
      } else {
        const checkpoints = [...state.checkpoints.values()]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 25);

        if (checkpoints.length === 0) {
          ctx.ui.notify("No checkpoints available", "warning");
          return;
        }

        const items = checkpoints.map((cp, i) => formatCheckpointLabel(cp, i, currentBranch));
        const choice = await ctx.ui.select("Quick rewind (files only):", items);
        if (!choice) return;

        const idx = items.indexOf(choice);
        if (idx < 0) return;
        target = checkpoints[idx];
      }

      if (!target) return;

      await performRestore(state, { ui: ctx.ui }, target, "files");
      ctx.ui.notify(`Files rewound to checkpoint`, "info");
    },
  });
}
