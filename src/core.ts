/**
 * pi-rewind — Core git operations
 *
 * Pure git functions with zero pi-coding-agent dependency.
 * Independently testable, safe to import from anywhere.
 */

import { spawn } from "child_process";
import { statSync, readdirSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================================
// Constants & Types
// ============================================================================

export const ZEROS = "0".repeat(40);
export const REF_BASE = "refs/pi-checkpoints";

/** Maximum size for untracked files to include in snapshot (10 MiB) */
export const MAX_UNTRACKED_FILE_SIZE = 10 * 1024 * 1024;

/** Maximum files in an untracked directory before skipping (200) */
export const MAX_UNTRACKED_DIR_FILES = 200;

/** Default max checkpoints before auto-pruning */
export const DEFAULT_MAX_CHECKPOINTS = 100;

/** Directories to exclude from snapshots (matched against any path component) */
export const IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "env",
  ".env",
  "dist",
  "build",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  ".tox",
  "__pycache__",
]);

/** Tools that modify the filesystem and warrant a checkpoint */
export const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export interface CheckpointData {
  /** Unique checkpoint ID (used as git ref name) */
  id: string;
  /** Session this checkpoint belongs to */
  sessionId: string;
  /** What triggered this checkpoint */
  trigger: "turn" | "tool" | "resume" | "before-restore";
  /** Turn index when checkpoint was created */
  turnIndex: number;
  /** Tool name if trigger === "tool" */
  toolName?: string;
  /** Human-readable description (prompt text, tool args, etc.) */
  description?: string;
  /** SHA of HEAD at snapshot time */
  headSha: string;
  /** SHA of the real git index tree */
  indexTreeSha: string;
  /** SHA of the full worktree tree (index + untracked) */
  worktreeTreeSha: string;
  /** Epoch ms when created */
  timestamp: number;
  /** Untracked files present when snapshot was taken (for safe restore) */
  preexistingUntrackedFiles?: string[];
  /** Files skipped because > 10 MiB */
  skippedLargeFiles?: string[];
  /** Directories skipped because >= 200 files */
  skippedLargeDirs?: string[];
}

// ============================================================================
// Git helpers
// ============================================================================

/**
 * Run a git command via spawn (no shell injection).
 * `cmd` is parsed into args respecting quotes.
 */
export function git(
  cmd: string,
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = parseArgs(cmd);
    const proc = spawn("git", args, {
      cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr || `git ${args[0]} failed (code ${code})`));
    });
    proc.on("error", reject);

    if (opts.input && proc.stdin) {
      proc.stdin.write(opts.input);
      proc.stdin.end();
    } else if (proc.stdin) {
      proc.stdin.end();
    }
  });
}

function parseArgs(cmd: string): string[] {
  const args: string[] = [];
  let cur = "";
  let sq = false;
  let dq = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'" && !dq) sq = !sq;
    else if (c === '"' && !sq) dq = !dq;
    else if (c === " " && !sq && !dq) {
      if (cur) { args.push(cur); cur = ""; }
    } else cur += c;
  }
  if (cur) args.push(cur);
  return args;
}

export const isGitRepo = (cwd: string) =>
  git("rev-parse --is-inside-work-tree", cwd).then(() => true).catch(() => false);

export const getRepoRoot = (cwd: string) =>
  git("rev-parse --show-toplevel", cwd);

// ============================================================================
// Path filtering
// ============================================================================

/** Returns true if any path component is in IGNORED_DIR_NAMES */
export function shouldIgnoreForSnapshot(path: string): boolean {
  return path.split(/[/\\]/).some((c) => IGNORED_DIR_NAMES.has(c));
}

/** Returns true if file exceeds MAX_UNTRACKED_FILE_SIZE */
export function isLargeFile(root: string, rel: string): boolean {
  try {
    const s = statSync(join(root, rel));
    return s.isFile() && s.size > MAX_UNTRACKED_FILE_SIZE;
  } catch { return false; }
}

/** Returns true if directory contains >= MAX_UNTRACKED_DIR_FILES files */
export function isLargeDirectory(root: string, rel: string): boolean {
  try {
    const full = join(root, rel);
    const s = statSync(full);
    if (!s.isDirectory()) return false;
    return countFiles(full, MAX_UNTRACKED_DIR_FILES) >= MAX_UNTRACKED_DIR_FILES;
  } catch { return false; }
}

function countFiles(dir: string, max: number): number {
  let n = 0;
  const walk = (d: string) => {
    if (n > max) return;
    try {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (n > max) return;
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.isFile()) n++;
      }
    } catch { /* permission errors */ }
  };
  walk(dir);
  return n;
}

function normalizeGitPath(p: string): string {
  let n = p.replace(/\\/g, "/");
  if (n.startsWith("./")) n = n.slice(2);
  return n.replace(/\/$/, "");
}

function isPathWithin(path: string, dir: string): boolean {
  if (!dir || dir === ".") return true;
  if (path === dir) return true;
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return path.startsWith(prefix);
}

function isPathWithinAny(path: string, dirs: Set<string>): boolean {
  for (const d of dirs) if (isPathWithin(path, d)) return true;
  return false;
}

// ============================================================================
// Status snapshot (what files need snapshotting)
// ============================================================================

interface StatusSnapshot {
  trackedPaths: string[];
  untrackedFiles: string[];
  untrackedFilesForIndex: string[];
  untrackedDirs: string[];
  skippedLargeFiles: string[];
}

async function captureStatusSnapshot(root: string): Promise<StatusSnapshot> {
  const snap: StatusSnapshot = {
    trackedPaths: [],
    untrackedFiles: [],
    untrackedFilesForIndex: [],
    untrackedDirs: [],
    skippedLargeFiles: [],
  };

  const output = await git("status --porcelain=2 -z --untracked-files=all", root).catch(() => "");
  if (!output) return snap;

  const entries = output.split("\0").filter(Boolean);
  let expectRename = false;

  for (const entry of entries) {
    if (expectRename) {
      const n = normalizeGitPath(entry);
      if (n) snap.trackedPaths.push(n);
      expectRename = false;
      continue;
    }

    const tag = entry[0];
    if (tag === "?" || tag === "!") {
      const sp = entry.indexOf(" ");
      if (sp === -1) continue;
      const raw = normalizeGitPath(entry.slice(sp + 1));
      if (!raw || shouldIgnoreForSnapshot(raw)) continue;

      let st: ReturnType<typeof statSync> | null = null;
      try { st = statSync(join(root, raw)); } catch { st = null; }

      if (st?.isDirectory()) { snap.untrackedDirs.push(raw); continue; }

      snap.untrackedFiles.push(raw);
      const large = st?.isFile() ? st.size > MAX_UNTRACKED_FILE_SIZE : false;
      if (large) snap.skippedLargeFiles.push(raw);
      else snap.untrackedFilesForIndex.push(raw);
    } else if (tag === "1") {
      const p = extractField(entry, 8);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
    } else if (tag === "2") {
      const p = extractField(entry, 9);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
      expectRename = true;
    } else if (tag === "u") {
      const p = extractField(entry, 10);
      if (p) snap.trackedPaths.push(normalizeGitPath(p));
    }
  }
  return snap;
}

function extractField(record: string, n: number): string | null {
  let spaces = 0;
  for (let i = 0; i < record.length; i++) {
    if (record[i] === " " && ++spaces === n) {
      const p = record.slice(i + 1);
      return p.length > 0 ? p : null;
    }
  }
  return null;
}

/** Detect directories with >= threshold untracked files */
function detectLargeDirs(files: string[], dirs: string[], threshold: number): string[] {
  if (threshold <= 0 || files.length === 0) return [];
  const counts = new Map<string, number>();

  const sortedDirs = [...dirs].sort((a, b) => {
    const da = a.split("/").length, db = b.split("/").length;
    return da !== db ? db - da : a.localeCompare(b);
  });

  for (const f of files) {
    let bucket: string | null = null;
    for (const d of sortedDirs) {
      if (isPathWithin(f, d)) { bucket = d; break; }
    }
    if (!bucket) {
      const parts = f.split("/");
      bucket = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    }
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([k, v]) => v >= threshold && k !== ".")
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

interface FilesToAddResult {
  filtered: string[];
  allUntracked: string[];
  skippedLargeFiles: string[];
  skippedLargeDirs: string[];
}

async function getFilesToAdd(root: string): Promise<FilesToAddResult> {
  const status = await captureStatusSnapshot(root);
  const largeDirs = detectLargeDirs(
    status.untrackedFiles,
    status.untrackedDirs,
    MAX_UNTRACKED_DIR_FILES,
  );
  const largeDirsSet = new Set(largeDirs);

  const untrackedForIndex = status.untrackedFilesForIndex
    .filter((p) => !isPathWithinAny(p, largeDirsSet));
  const skippedLargeFiles = status.skippedLargeFiles
    .filter((p) => !isPathWithinAny(p, largeDirsSet));

  const all = new Set<string>();
  status.trackedPaths.forEach((p) => all.add(p));
  untrackedForIndex.forEach((p) => all.add(p));

  return {
    filtered: [...all],
    allUntracked: status.untrackedFiles,
    skippedLargeFiles,
    skippedLargeDirs: largeDirs,
  };
}

// ============================================================================
// Checkpoint CRUD
// ============================================================================

export interface CreateCheckpointOpts {
  root: string;
  id: string;
  sessionId: string;
  trigger: CheckpointData["trigger"];
  turnIndex: number;
  toolName?: string;
  /** Human-readable label (user prompt, tool args summary) */
  description?: string;
}

/**
 * Snapshot HEAD + index + worktree into a git ref.
 * Returns full checkpoint metadata.
 */
export async function createCheckpoint(opts: CreateCheckpointOpts): Promise<CheckpointData> {
  const { root, id, sessionId, trigger, turnIndex, toolName, description } = opts;
  const timestamp = Date.now();
  const iso = new Date(timestamp).toISOString();

  const headSha = await git("rev-parse HEAD", root).catch(() => ZEROS);
  const indexTreeSha = await git("write-tree", root);

  const tmpDir = await mkdtemp(join(tmpdir(), "pi-rewind-"));
  const tmpIndex = join(tmpDir, "index");

  try {
    const tmpEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    const { filtered, allUntracked, skippedLargeFiles, skippedLargeDirs } =
      await getFilesToAdd(root);

    const largeDirsSet = new Set(skippedLargeDirs);
    const largeFilesSet = new Set(skippedLargeFiles);
    const preexistingUntrackedFiles = allUntracked.filter((f) => {
      if (shouldIgnoreForSnapshot(f)) return false;
      if (largeFilesSet.has(f)) return false;
      if (isPathWithinAny(f, largeDirsSet)) return false;
      return true;
    });

    // Seed temp index from HEAD
    if (headSha !== ZEROS) {
      await git(`read-tree ${headSha}`, root, { env: tmpEnv });
    }

    // Add files in batches of 100
    const BATCH = 100;
    for (let i = 0; i < filtered.length; i += BATCH) {
      const batch = filtered.slice(i, i + BATCH);
      const paths = batch.map((f) => `"${f}"`).join(" ");
      await git(`add --all -- ${paths}`, root, { env: tmpEnv });
    }

    const worktreeTreeSha = await git("write-tree", root, { env: tmpEnv });

    // Build commit message with all metadata
    const msg = [
      `pi-rewind:${id}`,
      `sessionId ${sessionId}`,
      `trigger ${trigger}`,
      `turn ${turnIndex}`,
      toolName ? `toolName ${toolName}` : null,
      description ? `description ${description}` : null,
      `head ${headSha}`,
      `index-tree ${indexTreeSha}`,
      `worktree-tree ${worktreeTreeSha}`,
      `created ${iso}`,
      `untracked ${JSON.stringify(preexistingUntrackedFiles)}`,
      `largeFiles ${JSON.stringify(skippedLargeFiles)}`,
      `largeDirs ${JSON.stringify(skippedLargeDirs)}`,
    ].filter(Boolean).join("\n");

    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-rewind",
      GIT_AUTHOR_EMAIL: "rewind@pi",
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_NAME: "pi-rewind",
      GIT_COMMITTER_EMAIL: "rewind@pi",
      GIT_COMMITTER_DATE: iso,
    };

    const commitSha = await git(`commit-tree ${worktreeTreeSha}`, root, {
      input: msg,
      env: commitEnv,
    });

    await git(`update-ref ${REF_BASE}/${id} ${commitSha}`, root);

    return {
      id,
      sessionId,
      trigger,
      turnIndex,
      toolName,
      description,
      headSha,
      indexTreeSha,
      worktreeTreeSha,
      timestamp,
      preexistingUntrackedFiles,
      skippedLargeFiles: skippedLargeFiles.length > 0 ? skippedLargeFiles : undefined,
      skippedLargeDirs: skippedLargeDirs.length > 0 ? skippedLargeDirs : undefined,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Restore worktree + index to a checkpoint's state.
 * Safely preserves pre-existing untracked files and skipped large items.
 */
export async function restoreCheckpoint(root: string, cp: CheckpointData): Promise<void> {
  // 1. Reset HEAD
  if (cp.headSha !== ZEROS) {
    await git(`reset --hard ${cp.headSha}`, root);
  }

  // 2. Restore worktree from snapshot tree
  await git(`read-tree --reset -u ${cp.worktreeTreeSha}`, root);

  // 3. Safe-clean new untracked files only
  await safeClean(
    root,
    cp.preexistingUntrackedFiles || [],
    cp.skippedLargeFiles || [],
    cp.skippedLargeDirs || [],
  );

  // 4. Restore staged state without touching files
  await git(`read-tree --reset ${cp.indexTreeSha}`, root);
}

async function safeClean(
  root: string,
  preexisting: string[],
  skippedFiles: string[],
  skippedDirs: string[],
): Promise<void> {
  const output = await git("ls-files --others --exclude-standard", root).catch(() => "");
  if (!output) return;
  const current = output.split("\n").filter(Boolean);
  if (current.length === 0) return;

  const preSet = new Set(preexisting);
  const sfSet = new Set(skippedFiles);
  const sdSet = new Set(skippedDirs);

  const toRemove = current.filter((f) => {
    if (preSet.has(f)) return false;
    if (shouldIgnoreForSnapshot(f)) return false;
    if (sfSet.has(f)) return false;
    if (isPathWithinAny(f, sdSet)) return false;
    return true;
  });

  if (toRemove.length === 0) return;

  const BATCH = 100;
  for (let i = 0; i < toRemove.length; i += BATCH) {
    const batch = toRemove.slice(i, i + BATCH);
    const paths = batch.map((f) => `"${f}"`).join(" ");
    await git(`clean -f -- ${paths}`, root).catch(() => {});
  }
}

// ============================================================================
// Load / list checkpoints
// ============================================================================

/** Load checkpoint metadata from a git ref */
export async function loadCheckpointFromRef(
  root: string,
  refName: string,
): Promise<CheckpointData | null> {
  try {
    const commitSha = await git(`rev-parse --verify ${REF_BASE}/${refName}`, root);
    const msg = await git(`cat-file commit ${commitSha}`, root);

    const get = (key: string) =>
      msg.match(new RegExp(`^${key} (.+)$`, "m"))?.[1]?.trim();

    const sid = get("sessionId");
    const turn = get("turn");
    const head = get("head");
    const idx = get("index-tree");
    const wt = get("worktree-tree");
    if (!sid || !turn || !head || !idx || !wt) return null;

    const parseJson = (key: string): string[] | undefined => {
      const raw = get(key);
      if (!raw) return undefined;
      try {
        const arr = JSON.parse(raw);
        return arr.length > 0 ? arr : undefined;
      } catch { return undefined; }
    };

    return {
      id: refName,
      sessionId: sid,
      trigger: (get("trigger") as CheckpointData["trigger"]) || "turn",
      turnIndex: parseInt(turn, 10),
      toolName: get("toolName"),
      description: get("description"),
      headSha: head,
      indexTreeSha: idx,
      worktreeTreeSha: wt,
      timestamp: get("created") ? new Date(get("created")!).getTime() : 0,
      preexistingUntrackedFiles: parseJson("untracked"),
      skippedLargeFiles: parseJson("largeFiles"),
      skippedLargeDirs: parseJson("largeDirs"),
    };
  } catch {
    return null;
  }
}

/** List all checkpoint ref names under REF_BASE */
export async function listCheckpointRefs(root: string): Promise<string[]> {
  try {
    const prefix = `${REF_BASE}/`;
    const out = await git(`for-each-ref --format=%(refname) ${prefix}`, root);
    return out.split("\n").filter(Boolean).map((r) => r.replace(prefix, ""));
  } catch {
    return [];
  }
}

/** Load all checkpoints, optionally filtered by session */
export async function loadAllCheckpoints(
  root: string,
  sessionId?: string,
): Promise<CheckpointData[]> {
  const refs = await listCheckpointRefs(root);
  const results = await Promise.all(refs.map((r) => loadCheckpointFromRef(root, r)));
  return results.filter(
    (cp): cp is CheckpointData =>
      cp !== null && (!sessionId || cp.sessionId === sessionId),
  );
}

/** Delete a checkpoint ref */
export async function deleteCheckpoint(root: string, id: string): Promise<void> {
  await git(`update-ref -d ${REF_BASE}/${id}`, root).catch(() => {});
}

/** Prune oldest checkpoints for a session, keeping at most `max` */
export async function pruneCheckpoints(
  root: string,
  sessionId: string,
  max: number = DEFAULT_MAX_CHECKPOINTS,
): Promise<number> {
  const all = await loadAllCheckpoints(root, sessionId);
  // Sort oldest first
  all.sort((a, b) => a.timestamp - b.timestamp);

  // Don't prune before-restore checkpoints — they're safety nets
  const prunable = all.filter((cp) => cp.trigger !== "before-restore");
  if (prunable.length <= max) return 0;

  const toDelete = prunable.slice(0, prunable.length - max);
  for (const cp of toDelete) {
    await deleteCheckpoint(root, cp.id);
  }
  return toDelete.length;
}

/** Get a diff summary between two checkpoint trees */
export async function diffCheckpoints(
  root: string,
  fromTree: string,
  toTree: string,
): Promise<string> {
  try {
    // diff-tree compares two tree objects and works with tree SHAs or commit refs
    return await git(`diff-tree --stat --no-commit-id ${fromTree} ${toTree}`, root);
  } catch {
    return "(diff unavailable)";
  }
}

// ============================================================================
// Utilities
// ============================================================================

/** Validate ID contains only safe characters */
export const isSafeId = (id: string) => /^[\w-]+$/.test(id);

/** Sanitize a string for use in git ref names */
export function sanitizeForRef(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]/g, "_");
}

/** Find checkpoint closest to a target timestamp */
export function findClosestCheckpoint(
  checkpoints: CheckpointData[],
  targetTs: number,
): CheckpointData | undefined {
  if (checkpoints.length === 0) return undefined;
  return checkpoints.reduce((best, cp) => {
    const bd = Math.abs(best.timestamp - targetTs);
    const cd = Math.abs(cp.timestamp - targetTs);
    if (cp.timestamp <= targetTs && best.timestamp > targetTs) return cp;
    if (best.timestamp <= targetTs && cp.timestamp > targetTs) return best;
    return cd < bd ? cp : best;
  });
}
