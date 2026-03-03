/**
 * pi-rewind — Benchmark
 *
 * Measures core operation performance across repo sizes.
 * Pi executes extension handlers with `await` sequentially,
 * so checkpoint time directly blocks the agent.
 *
 * Run: npx tsx tests/bench.ts
 */

import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  git,
  createCheckpoint,
  restoreCheckpoint,
  loadAllCheckpoints,
  diffCheckpoints,
  pruneCheckpoints,
  deleteCheckpoint,
} from "../src/core.js";
import type { CreateCheckpointOpts, CheckpointData } from "../src/core.js";

// ============================================================================
// Config
// ============================================================================

const REPO_SIZES = [
  { name: "small",  files: 20,   fileSizeBytes: 500,   desc: "20 files, ~10 KB" },
  { name: "medium", files: 500,  fileSizeBytes: 2000,  desc: "500 files, ~1 MB" },
  { name: "large",  files: 5000, fileSizeBytes: 5000,  desc: "5,000 files, ~25 MB" },
];

const CHECKPOINT_COUNTS = [1, 25, 100];
const ITERATIONS = 5;

// ============================================================================
// Helpers
// ============================================================================

function randomContent(bytes: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n ";
  let s = "";
  for (let i = 0; i < bytes; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createBenchRepo(fileCount: number, fileSize: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-rewind-bench-"));
  await git("init", dir);
  await git('config user.email "bench@test.com"', dir);
  await git('config user.name "Bench"', dir);

  // Create files in subdirectories (realistic structure)
  const dirsNeeded = Math.ceil(fileCount / 50);
  for (let d = 0; d < dirsNeeded; d++) {
    await mkdir(join(dir, `src/dir${d}`), { recursive: true });
  }

  for (let i = 0; i < fileCount; i++) {
    const subdir = `src/dir${Math.floor(i / 50)}`;
    await writeFile(join(dir, subdir, `file${i}.ts`), randomContent(fileSize));
  }

  await git("add .", dir);
  await git('commit -m "initial"', dir);
  return dir;
}

function makeOpts(root: string, index: number): CreateCheckpointOpts {
  return {
    root,
    id: `bench-${Date.now()}-${index}`,
    sessionId: "bench-session",
    trigger: "tool",
    turnIndex: index,
    description: `Benchmark checkpoint ${index}`,
  };
}

async function measure(fn: () => Promise<void>): Promise<{ ms: number; cpuUs: number; memDeltaKB: number }> {
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const start = performance.now();

  await fn();

  const ms = performance.now() - start;
  const cpuAfter = process.cpuUsage(cpuBefore);
  const memAfter = process.memoryUsage();

  return {
    ms: Math.round(ms * 100) / 100,
    cpuUs: cpuAfter.user + cpuAfter.system,
    memDeltaKB: Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024),
  };
}

async function median(fn: () => Promise<{ ms: number; cpuUs: number; memDeltaKB: number }>, n: number) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await fn());
  results.sort((a, b) => a.ms - b.ms);
  return results[Math.floor(n / 2)];
}

function fmt(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtCpu(us: number): string {
  if (us < 1000) return `${us}µs`;
  return `${(us / 1000).toFixed(1)}ms`;
}

// ============================================================================
// Benchmark
// ============================================================================

interface BenchResult {
  repo: string;
  operation: string;
  time: string;
  cpu: string;
  memDelta: string;
}

async function benchRepo(config: typeof REPO_SIZES[0]): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  console.log(`\n📦 ${config.name.toUpperCase()} — ${config.desc}`);

  const dir = await createBenchRepo(config.files, config.fileSizeBytes);
  console.log(`  Repo created at ${dir}`);

  // 1. createCheckpoint
  const createResult = await median(async () => {
    const opts = makeOpts(dir, Math.floor(Math.random() * 10000));
    const r = await measure(async () => { await createCheckpoint(opts); });
    return r;
  }, ITERATIONS);
  console.log(`  createCheckpoint:     ${fmt(createResult.ms)} (CPU: ${fmtCpu(createResult.cpuUs)}, mem: ${createResult.memDeltaKB}KB)`);
  results.push({ repo: config.name, operation: "createCheckpoint", time: fmt(createResult.ms), cpu: fmtCpu(createResult.cpuUs), memDelta: `${createResult.memDeltaKB}KB` });

  // 2. loadAllCheckpoints with varying counts
  for (const count of CHECKPOINT_COUNTS) {
    // Create N checkpoints
    const cps: CheckpointData[] = [];
    for (let i = 0; i < count; i++) {
      // Modify a file each time so tree SHA differs
      await writeFile(join(dir, `src/dir0/file0.ts`), randomContent(config.fileSizeBytes));
      const cp = await createCheckpoint(makeOpts(dir, i));
      cps.push(cp);
    }

    const loadResult = await median(async () => {
      return measure(async () => { await loadAllCheckpoints(dir, "bench-session"); });
    }, ITERATIONS);
    console.log(`  loadAllCheckpoints(${String(count).padStart(3)}): ${fmt(loadResult.ms)} (CPU: ${fmtCpu(loadResult.cpuUs)})`);
    results.push({ repo: config.name, operation: `loadAll(${count})`, time: fmt(loadResult.ms), cpu: fmtCpu(loadResult.cpuUs), memDelta: `${loadResult.memDeltaKB}KB` });

    // 3. diffCheckpoints (only for the last batch)
    if (count === CHECKPOINT_COUNTS[CHECKPOINT_COUNTS.length - 1] && cps.length >= 2) {
      const diffResult = await median(async () => {
        return measure(async () => { await diffCheckpoints(dir, cps[0], cps[cps.length - 1]); });
      }, ITERATIONS);
      console.log(`  diffCheckpoints:      ${fmt(diffResult.ms)} (CPU: ${fmtCpu(diffResult.cpuUs)})`);
      results.push({ repo: config.name, operation: "diffCheckpoints", time: fmt(diffResult.ms), cpu: fmtCpu(diffResult.cpuUs), memDelta: `${diffResult.memDeltaKB}KB` });
    }

    // 4. restoreCheckpoint (only for last batch)
    if (count === CHECKPOINT_COUNTS[CHECKPOINT_COUNTS.length - 1] && cps.length >= 1) {
      const restoreResult = await median(async () => {
        return measure(async () => { await restoreCheckpoint(dir, cps[0]); });
      }, ITERATIONS);
      console.log(`  restoreCheckpoint:    ${fmt(restoreResult.ms)} (CPU: ${fmtCpu(restoreResult.cpuUs)})`);
      results.push({ repo: config.name, operation: "restoreCheckpoint", time: fmt(restoreResult.ms), cpu: fmtCpu(restoreResult.cpuUs), memDelta: `${restoreResult.memDeltaKB}KB` });
    }

    // 5. pruneCheckpoints
    if (count === CHECKPOINT_COUNTS[CHECKPOINT_COUNTS.length - 1]) {
      const pruneResult = await median(async () => {
        return measure(async () => { await pruneCheckpoints(dir, "bench-session", 10); });
      }, ITERATIONS);
      console.log(`  pruneCheckpoints:     ${fmt(pruneResult.ms)} (CPU: ${fmtCpu(pruneResult.cpuUs)})`);
      results.push({ repo: config.name, operation: "pruneCheckpoints", time: fmt(pruneResult.ms), cpu: fmtCpu(pruneResult.cpuUs), memDelta: `${pruneResult.memDeltaKB}KB` });
    }

    // Clean up checkpoints for next round
    for (const cp of cps) {
      await deleteCheckpoint(dir, cp.id).catch(() => {});
    }
  }

  // 6. Disk usage
  const objects = await git("count-objects -vH", dir).catch(() => "");
  const sizeMatch = objects.match(/size-pack:\s*(.+)/);
  const countMatch = objects.match(/count:\s*(\d+)/);
  console.log(`  Git objects: ${countMatch?.[1] || "?"}, pack size: ${sizeMatch?.[1] || "?"}`);

  // Cleanup
  await rm(dir, { recursive: true, force: true });

  return results;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log("🏁 pi-rewind benchmark");
  console.log(`   Iterations per measurement: ${ITERATIONS} (median)`);
  console.log(`   Node: ${process.version}`);
  console.log(`   Git: ${(await git("--version", ".")).trim()}`);

  const allResults: BenchResult[] = [];

  for (const config of REPO_SIZES) {
    const results = await benchRepo(config);
    allResults.push(...results);
  }

  // Summary table
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  console.log(
    "Repo".padEnd(8) +
    "Operation".padEnd(22) +
    "Time".padEnd(10) +
    "CPU".padEnd(12) +
    "Mem Δ".padEnd(10)
  );
  console.log("-".repeat(62));
  for (const r of allResults) {
    console.log(
      r.repo.padEnd(8) +
      r.operation.padEnd(22) +
      r.time.padEnd(10) +
      r.cpu.padEnd(12) +
      r.memDelta.padEnd(10)
    );
  }

  // Key insight
  console.log("\n💡 Key insight: Pi awaits extension handlers sequentially.");
  console.log("   createCheckpoint time = direct latency added to each turn.");
}

main().catch(console.error);
