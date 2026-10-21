import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** Load the extension against a mock host. omp injects `logger`; pi does not. */
function setup(ompShaped: boolean) {
  const handlers = new Map<string, Handler>();
  const commands: string[] = [];
  const shortcuts: string[] = [];
  const pi: Record<string, unknown> = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerCommand(name: string) {
      commands.push(name);
    },
    registerShortcut(key: string) {
      shortcuts.push(key);
    },
  };
  if (ompShaped) pi.logger = {};
  extension(pi as never);
  return { handlers, commands, shortcuts };
}

function makeCtx(cwd: string, select: (title: string, options: string[]) => string | undefined) {
  return {
    cwd,
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => select(title, options),
      notify() {},
      setStatus() {},
      clearStatus() {},
      theme: { fg: (_color: string, text: string) => text },
    },
    sessionManager: {
      getSessionId: () => "test-session",
      getBranch: () => [],
      getEntry: () => ({ timestamp: new Date().toISOString() }),
    },
  };
}

async function main(): Promise<void> {
  // ---- omp-shaped host: handlers registered, tree prompt deferred ----
  const omp = setup(true);
  assert.deepEqual(omp.commands.sort(), ["rewind", "rw"]);
  assert.deepEqual(omp.shortcuts, ["escape escape"]);
  for (const event of [
    "session_start",
    "session_switch",
    "session_before_fork",
    "session_before_branch",
    "session_before_tree",
    "session_tree",
  ]) {
    assert.ok(omp.handlers.has(event), `missing ${event} handler`);
  }

  const nonGitCtx = makeCtx("/tmp/pi-rewind-extension-test-non-git", () => undefined);
  for (const event of ["startup", "fork"] as const) {
    await omp.handlers.get("session_start")!({ reason: event }, nonGitCtx);
  }
  for (const reason of ["resume", "fork"] as const) {
    await omp.handlers.get("session_switch")!({ reason }, nonGitCtx);
  }
  await omp.handlers.get("session_before_fork")!({ entryId: "test-entry" }, nonGitCtx);
  await omp.handlers.get("session_before_branch")!({ entryId: "test-entry" }, nonGitCtx);
  const deferred = await omp.handlers.get("session_before_tree")!({ preparation: { targetId: "test-entry" } }, nonGitCtx);
  assert.equal(deferred, undefined, "omp must not prompt inside session_before_tree");
  await omp.handlers.get("session_tree")!({}, nonGitCtx);
  // The deferred prompt timer is still pending; node keeps the process alive
  // until it fires, so nothing is asserted against a slept duration.

  // ---- Pi host: pre-navigation prompt can cancel the navigation ----
  const repo = mkdtempSync(join(tmpdir(), "pi-rewind-ext-"));
  try {
    const g = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    g("init", "-q");
    g("config", "user.email", "test@test");
    g("config", "user.name", "test");
    writeFileSync(join(repo, "a.txt"), "one\n");
    g("add", ".");
    g("commit", "-qm", "init");

    const pi = setup(false);
    const prompts: string[][] = [];
    const piCtx = makeCtx(repo, (_title, options) => {
      prompts.push(options);
      return undefined; // dismissed prompt
    });

    await pi.handlers.get("session_start")!({ reason: "startup" }, piCtx);
    const result = await pi.handlers.get("session_before_tree")!(
      { preparation: { targetId: "test-entry" } },
      piCtx,
    );

    assert.deepEqual(result, { cancel: true }, "dismissing the Pi prompt must cancel navigation");
    assert.deepEqual(prompts, [
      ["Keep current files", "Restore files to that point", "Cancel navigation"],
    ]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }

  console.log("✅ extension smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
