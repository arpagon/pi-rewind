/**
 * pi-rewind — UI helpers
 *
 * Footer status and notifications.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RewindState } from "./state.js";

const STATUS_KEY = "rewind";
let lastHintCount = 0;

/** Update footer status with checkpoint count and optional cleanup hint */
export function updateStatus(state: RewindState, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (!state.gitAvailable) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const total = state.checkpoints.size;
  const threshold = state.config.cleanupHintThreshold;

  // Build status text
  let text = theme.fg("dim", "◆ ") + theme.fg("muted", `${total} checkpoint${total === 1 ? "" : "s"}`);
  if (total > threshold && total > 0) {
    text += " " + theme.fg("warning", `(consider /rewind-cleanup)`);
  }

  ctx.ui.setStatus(STATUS_KEY, text);

  // Show notification once per threshold crossing
  if (total > threshold && total !== lastHintCount) {
    lastHintCount = total;
    ctx.ui.notify(
      `${total} checkpoints accumulated. Run /rewind-cleanup to prune old ones.`,
      "info",
    );
  }
}

/** Clear status */
export function clearStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
  lastHintCount = 0;
}
