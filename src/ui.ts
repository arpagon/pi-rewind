/**
 * pi-rewind — UI helpers
 *
 * Footer status and notifications.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { RewindState } from "./state.js";

const STATUS_KEY = "rewind";

/** Update footer status with checkpoint count */
export function updateStatus(state: RewindState, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (!state.gitAvailable) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  const theme = ctx.ui.theme;
  const count = state.checkpoints.size;
  ctx.ui.setStatus(
    STATUS_KEY,
    theme.fg("dim", "◆ ") + theme.fg("muted", `${count} checkpoint${count === 1 ? "" : "s"}`),
  );
}

/** Clear status */
export function clearStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
