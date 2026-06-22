/**
 * pi-rewind — Core unit tests
 *
 * Tests git operations on a disposable temp repo. No pi dependency needed.
 *
 * Run: npx tsx tests/core.test.ts
 */

import { mkdtemp, rm, writeFile, mkdir, readFile, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  git,
  isGitRepo,
  getRepoRoot,
  createCheckpoint,
  restoreCheckpoint,
  loadCheckpointFromRef,
  listCheckpointRefs,
  loadAllCheckpoints,
  deleteCheckpoint,
  pruneCheckpoints,
  pruneOldSessions,
  pruneAllOldSessions,
  deleteCheckpointsBulk,
  getCheckpointStats,
  diffCheckpoints,
  findClosestCheckpoint,
  shouldIgnoreForSnapshot,
  sanitizeForRef,
  isSafeId,
  MUTATING_TOOLS,
  type CreateCheckpointOpts,
  type CheckpointData,
} from "../src/core.js";

// ============================================================================
// Test harness
// ============================================================================

let passed = 0;
let failed = 0;
const errors: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`  ✗ ${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

// ============================================================================
// Repo setup helpers
// ============================================================================

async function createTempRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-rewind-test-"));
  await git("init", dir);
  await git('config user.email "test@test.com"', dir);
  await git('config user.name "Test"', dir);

  // Initial commit so HEAD exists
  await writeFile(join(dir, "README.md"), "# Test\n");
  await git("add .", dir);
  await git('commit -m "initial"', dir);

  return dir;
}

async function cleanupRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function makeOpts(root: string, overrides: Partial<CreateCheckpointOpts> = {}): CreateCheckpointOpts {
  return {
    root,
    id: `test-${Date.now()}`,
    sessionId: "test-session",
    trigger: "turn",
    turnIndex: 0,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

async function runTests() {
  console.log("\n🧪 pi-rewind core tests\n");

  // ------ Utilities ------

  console.log("Utilities:");

  await test("isSafeId accepts valid IDs", async () => {
    assert(isSafeId("abc-123_def"), "should accept alphanumeric + dash + underscore");
    assert(!isSafeId("abc def"), "should reject spaces");
    assert(!isSafeId("abc/def"), "should reject slashes");
    assert(!isSafeId(""), "should reject empty");
  });

  await test("sanitizeForRef cleans special characters", async () => {
    assertEqual(sanitizeForRef("abc:def/ghi"), "abc_def_ghi", "colons and slashes");
    assertEqual(sanitizeForRef("hello-world_123"), "hello-world_123", "safe chars untouched");
  });

  await test("shouldIgnoreForSnapshot filters known dirs", async () => {
    assert(shouldIgnoreForSnapshot("node_modules/foo.js"), "node_modules");
    assert(shouldIgnoreForSnapshot("src/.venv/bin/python"), ".venv");
    assert(shouldIgnoreForSnapshot("dist/index.js"), "dist");
    assert(!shouldIgnoreForSnapshot("src/index.ts"), "src should pass");
    assert(!shouldIgnoreForSnapshot("lib/utils.ts"), "lib should pass");
  });

  await test("MUTATING_TOOLS has expected tools", async () => {
    assert(MUTATING_TOOLS.has("write"), "write");
    assert(MUTATING_TOOLS.has("edit"), "edit");
    assert(MUTATING_TOOLS.has("bash"), "bash");
    assert(!MUTATING_TOOLS.has("read"), "read should not be mutating");
  });

  // ------ Git helpers ------

  console.log("\nGit helpers:");

  let repo = "";

  await test("isGitRepo returns true for git repo", async () => {
    repo = await createTempRepo();
    assertEqual(await isGitRepo(repo), true, "temp repo");
  });

  await test("isGitRepo returns false for non-repo", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "not-a-repo-"));
    try {
      assertEqual(await isGitRepo(tmp), false, "plain dir");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  await test("getRepoRoot returns correct path", async () => {
    const root = await getRepoRoot(repo);
    // Resolve symlinks for macOS /private/tmp
    const { realpathSync } = await import("fs");
    assertEqual(realpathSync(root), realpathSync(repo), "root matches");
  });

  // ------ Checkpoint CRUD ------

  console.log("\nCheckpoint CRUD:");

  await test("createCheckpoint returns valid data", async () => {
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-1", turnIndex: 0 }));
    assertEqual(cp.id, "cp-1", "id");
    assertEqual(cp.sessionId, "test-session", "sessionId");
    assertEqual(cp.trigger, "turn", "trigger");
    assertEqual(cp.turnIndex, 0, "turnIndex");
    assert(cp.headSha.length === 40, "headSha is 40 chars");
    assert(cp.worktreeTreeSha.length === 40, "worktreeTreeSha is 40 chars");
    assert(cp.timestamp > 0, "timestamp > 0");
  });

  await test("loadCheckpointFromRef roundtrips", async () => {
    const loaded = await loadCheckpointFromRef(repo, "cp-1");
    assert(loaded !== null, "loaded should not be null");
    assertEqual(loaded!.id, "cp-1", "id");
    assertEqual(loaded!.sessionId, "test-session", "sessionId");
    assertEqual(loaded!.trigger, "turn", "trigger");
  });

  await test("listCheckpointRefs lists created refs", async () => {
    await createCheckpoint(makeOpts(repo, { id: "cp-2", turnIndex: 1 }));
    const refs = await listCheckpointRefs(repo);
    assert(refs.includes("cp-1"), "cp-1 in list");
    assert(refs.includes("cp-2"), "cp-2 in list");
  });

  await test("loadAllCheckpoints filters by session", async () => {
    await createCheckpoint(makeOpts(repo, { id: "cp-other", sessionId: "other-session" }));
    const all = await loadAllCheckpoints(repo);
    assert(all.length >= 3, "has at least 3 checkpoints");

    const filtered = await loadAllCheckpoints(repo, "test-session");
    assert(filtered.every((cp) => cp.sessionId === "test-session"), "all match session");
    assert(!filtered.some((cp) => cp.id === "cp-other"), "other session excluded");
  });

  await test("deleteCheckpoint removes ref", async () => {
    await deleteCheckpoint(repo, "cp-other");
    const refs = await listCheckpointRefs(repo);
    assert(!refs.includes("cp-other"), "cp-other deleted");
  });

  // ------ Snapshot & Restore ------

  console.log("\nSnapshot & Restore:");

  await test("restore reverts file changes", async () => {
    // Create a checkpoint with file "a.txt"
    await writeFile(join(repo, "a.txt"), "version 1");
    await git("add a.txt", repo);
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-restore", turnIndex: 5 }));

    // Modify the file
    await writeFile(join(repo, "a.txt"), "version 2");
    const before = await readFile(join(repo, "a.txt"), "utf-8");
    assertEqual(before, "version 2", "file modified");

    // Restore
    await restoreCheckpoint(repo, cp);
    const after = await readFile(join(repo, "a.txt"), "utf-8");
    assertEqual(after, "version 1", "file restored");
  });

  await test("restore preserves pre-existing untracked files", async () => {
    // Create untracked file, then checkpoint
    await writeFile(join(repo, "preexisting.txt"), "keep me");
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-safe", turnIndex: 6 }));

    // Add a new untracked file
    await writeFile(join(repo, "new-file.txt"), "delete me");

    // Restore should keep preexisting.txt but remove new-file.txt
    await restoreCheckpoint(repo, cp);

    const exists = await stat(join(repo, "preexisting.txt")).then(() => true).catch(() => false);
    assert(exists, "preexisting file preserved");

    const newExists = await stat(join(repo, "new-file.txt")).then(() => true).catch(() => false);
    assert(!newExists, "new file removed");
  });

  await test("snapshot ignores node_modules", async () => {
    await mkdir(join(repo, "node_modules"), { recursive: true });
    await writeFile(join(repo, "node_modules", "pkg.js"), "module");
    const cp = await createCheckpoint(makeOpts(repo, { id: "cp-ignore" }));
    // node_modules content should not appear in preexistingUntrackedFiles
    const hasNM = cp.preexistingUntrackedFiles?.some((f) => f.includes("node_modules"));
    assert(!hasNM, "node_modules excluded from preexisting list");
  });

  // ------ Tool checkpoints ------

  console.log("\nTool checkpoints:");

  await test("createCheckpoint with tool trigger stores toolName", async () => {
    const cp = await createCheckpoint(makeOpts(repo, {
      id: "cp-tool-write",
      trigger: "tool",
      toolName: "write",
    }));
    assertEqual(cp.trigger, "tool", "trigger");
    assertEqual(cp.toolName, "write", "toolName");

    const loaded = await loadCheckpointFromRef(repo, "cp-tool-write");
    assertEqual(loaded!.trigger, "tool", "loaded trigger");
    assertEqual(loaded!.toolName, "write", "loaded toolName");
  });

  // ------ Pruning ------

  console.log("\nPruning:");

  await test("pruneCheckpoints removes oldest", async () => {
    // Create 5 checkpoints in a new session
    for (let i = 0; i < 5; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `prune-${i}`,
        sessionId: "prune-session",
        turnIndex: i,
      }));
    }

    const pruned = await pruneCheckpoints(repo, "prune-session", 3);
    assertEqual(pruned, 2, "pruned 2");

    const remaining = await loadAllCheckpoints(repo, "prune-session");
    assertEqual(remaining.length, 3, "3 remaining");
  });

  // ------ Bulk Delete ------

  console.log("\nBulk Delete:");

  await test("deleteCheckpointsBulk removes multiple refs", async () => {
    for (let i = 0; i < 3; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `bulk-${i}`,
        sessionId: "bulk-session",
        turnIndex: i,
      }));
    }

    const refsBefore = await listCheckpointRefs(repo);
    assert(refsBefore.includes("bulk-0"), "bulk-0 exists before");
    assert(refsBefore.includes("bulk-1"), "bulk-1 exists before");
    assert(refsBefore.includes("bulk-2"), "bulk-2 exists before");

    const deleted = await deleteCheckpointsBulk(repo, ["bulk-0", "bulk-1", "bulk-2"]);
    assertEqual(deleted, 3, "deleted 3");

    const refsAfter = await listCheckpointRefs(repo);
    assert(!refsAfter.includes("bulk-0"), "bulk-0 gone");
    assert(!refsAfter.includes("bulk-1"), "bulk-1 gone");
    assert(!refsAfter.includes("bulk-2"), "bulk-2 gone");
  });

  // ------ Cross-Session Pruning ------
  // NOTE: pruneOldSessions / pruneAllOldSessions extract sessionId from the ref
  // name, so checkpoints must use the standard ID format with an embedded UUID.

  console.log("\nCross-Session Pruning:");

  const OLD_UUID = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const OLD_UUID2 = "bbbb2222-cccc-4ddd-8eee-ffffffffffff";
  const OLD_UUID3 = "cccc3333-dddd-4eee-8fff-aaaaaaaaaaaa";
  const OLD_UUID4 = "dddd4444-eeee-4fff-8aaa-bbbbbbbbbbbb";

  await test("pruneOldSessions removes checkpoints from old sessions", async () => {
    const ts = Date.now();
    for (let i = 0; i < 3; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `turn-${OLD_UUID}-${i}-${ts + i}`,
        sessionId: OLD_UUID,
        turnIndex: i,
      }));
    }

    // Verify they exist
    const oldCheckpoints = await loadAllCheckpoints(repo, OLD_UUID);
    assertEqual(oldCheckpoints.length, 3, "3 old checkpoints exist");

    // Prune with keepPerOldSession=0
    const pruned = await pruneOldSessions(repo, "current-session", 0);
    assertEqual(pruned, 3, "pruned 3 old checkpoints");

    const remaining = await loadAllCheckpoints(repo, OLD_UUID);
    assertEqual(remaining.length, 0, "no old checkpoints remain");
  });

  await test("pruneOldSessions respects keepPerOldSession", async () => {
    const ts = Date.now();
    for (let i = 0; i < 5; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `turn-${OLD_UUID2}-${i}-${ts + i}`,
        sessionId: OLD_UUID2,
        turnIndex: i,
      }));
    }

    // Prune keeping 2 per old session
    const pruned = await pruneOldSessions(repo, "current-session", 2);
    assertEqual(pruned, 3, "pruned 3 of 5");

    const remaining = await loadAllCheckpoints(repo, OLD_UUID2);
    assertEqual(remaining.length, 2, "2 kept per old session");
  });

  await test("pruneAllOldSessions deletes all non-current checkpoints", async () => {
    const ts = Date.now();
    const currentUuid = "0000aaaa-1111-4bbb-8ccc-dddddddddddd";

    await createCheckpoint(makeOpts(repo, {
      id: `turn-${currentUuid}-0-${ts}`,
      sessionId: currentUuid,
      turnIndex: 0,
    }));
    await createCheckpoint(makeOpts(repo, {
      id: `turn-${OLD_UUID3}-0-${ts + 1}`,
      sessionId: OLD_UUID3,
      turnIndex: 0,
    }));
    await createCheckpoint(makeOpts(repo, {
      id: `turn-${OLD_UUID4}-0-${ts + 2}`,
      sessionId: OLD_UUID4,
      turnIndex: 0,
    }));

    const deleted = await pruneAllOldSessions(repo, currentUuid);
    assert(deleted >= 2, `deleted >= 2 old session checkpoints (got ${deleted})`);

    const currentRemaining = await loadAllCheckpoints(repo, currentUuid);
    assertEqual(currentRemaining.length, 1, "current session checkpoint kept");
    assert(currentRemaining[0].id.includes("0000aaaa"), "keep-me survived");

    // Old sessions we created should be empty
    const oldA = await loadAllCheckpoints(repo, OLD_UUID3);
    assertEqual(oldA.length, 0, "old session A fully pruned");

    const oldB = await loadAllCheckpoints(repo, OLD_UUID4);
    assertEqual(oldB.length, 0, "old session B fully pruned");
  });

  // ------ Checkpoint Stats ------

  console.log("\nCheckpoint Stats:");

  await test("getCheckpointStats computes correct counts", async () => {
    // Create fresh checkpoints with a unique session ID for stats testing
    const statsSid = "stats-current";
    const statsOld = "eeee5555-aaaa-4bbb-8ccc-444444444444";
    const ts = Date.now();

    for (let i = 0; i < 3; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `turn-${statsSid}-${i}-${ts + i}`,
        sessionId: statsSid,
        turnIndex: i,
      }));
    }
    for (let i = 0; i < 2; i++) {
      await createCheckpoint(makeOpts(repo, {
        id: `turn-${statsOld}-${i}-${ts + 10 + i}`,
        sessionId: statsOld,
        turnIndex: i,
      }));
    }

    const stats = await getCheckpointStats(repo, statsSid);
    assertEqual(stats.currentSessionId, statsSid, "current session id");
    assertEqual(stats.currentSessionCount, 3, "current session has 3");
    // Repo accumulates checkpoints from earlier tests, so oldSessionsCount >= 2
    assert(stats.oldSessionsCount >= 2, `old sessions total >= 2 (got ${stats.oldSessionsCount})`);
    assert(stats.oldSessionCount >= 1, "at least 1 old session group");
    assert(stats.total >= 5, `total >= 5 (got ${stats.total})`);

    const oldGroup = stats.oldSessionGroups.find((g) => g.sessionId === statsOld);
    assert(oldGroup !== undefined, "old session group found");
    assertEqual(oldGroup!.count, 2, "old group has 2 checkpoints");
    assert(oldGroup!.newestTimestamp >= oldGroup!.oldestTimestamp, "timestamps ordered");
  });

  // ------ Diff Checkpoints ------

  console.log("\nDiff:");

  await test("diffCheckpoints returns stat output", async () => {
    // Create checkpoint A
    await writeFile(join(repo, "diff-test.txt"), "before");
    await git("add diff-test.txt", repo);
    const cpA = await createCheckpoint(makeOpts(repo, {
      id: `diff-a`,
      sessionId: "diff-session",
      trigger: "tool",
      turnIndex: 0,
    }));

    // Modify and create checkpoint B
    await writeFile(join(repo, "diff-test.txt"), "after changes");
    await git("add diff-test.txt", repo);
    const cpB = await createCheckpoint(makeOpts(repo, {
      id: `diff-b`,
      sessionId: "diff-session",
      trigger: "tool",
      turnIndex: 1,
    }));

    const diff = await diffCheckpoints(repo, cpA.worktreeTreeSha, cpB.worktreeTreeSha);
    assert(diff.length > 0, "diff output is non-empty");
    assert(diff.includes("diff-test.txt"), "diff mentions the changed file");
  });

  // ------ findClosestCheckpoint ------

  console.log("\nfindClosestCheckpoint:");

  await test("finds checkpoint before target", async () => {
    const cps: CheckpointData[] = [
      { id: "a", timestamp: 100 } as CheckpointData,
      { id: "b", timestamp: 200 } as CheckpointData,
      { id: "c", timestamp: 300 } as CheckpointData,
    ];
    const result = findClosestCheckpoint(cps, 250);
    assertEqual(result?.id, "b", "b is closest before 250");
  });

  await test("returns undefined for empty array", async () => {
    const result = findClosestCheckpoint([], 100);
    assertEqual(result, undefined, "empty");
  });

  // ------ Branch safety ------

  await test("restore blocks cross-branch restore", async () => {
    const branchRepo = await createTempRepo();
    try {
      // Create checkpoint on main
      const cp = await createCheckpoint({
        root: branchRepo,
        id: `branch-test-${Date.now()}`,
        sessionId: "branch-test",
        trigger: "tool",
        turnIndex: 0,
        description: "on main",
      });

      // Create and switch to feature branch
      await git("checkout -b feature", branchRepo);
      await writeFile(join(branchRepo, "feature.txt"), "feature content");
      await git("add .", branchRepo);
      await git('commit -m "feature commit"', branchRepo);

      // Try to restore main checkpoint while on feature — should throw
      let threw = false;
      try {
        await restoreCheckpoint(branchRepo, cp);
      } catch (e: any) {
        threw = true;
        assert(e.message.includes("Branch mismatch"), `expected branch mismatch error, got: ${e.message}`);
      }
      assert(threw, "should have thrown on cross-branch restore");
    } finally {
      await rm(branchRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ------ Cleanup ------

  await cleanupRepo(repo);

  // ------ Summary ------

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (errors.length > 0) {
    console.log("Failures:");
    errors.forEach((e) => console.log(e));
  }
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
