/**
 * pi-rewind — Configuration
 *
 * Loads config from ~/.pi/agent/config/rewind.json,
 * with environment variable overrides.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface RewindConfig {
  /** Max checkpoints to keep in current session (0 = unlimited) */
  maxCheckpoints: number;
  /** Keep checkpoints from old sessions (default: false) */
  keepOldSessions: boolean;
  /** Threshold for hinting that it's time to clean up */
  cleanupHintThreshold: number;
}

const CONFIG_DIR = join(homedir(), ".pi", "agent", "config");
const CONFIG_PATH = join(CONFIG_DIR, "rewind.json");

const DEFAULTS: RewindConfig = {
  maxCheckpoints: 50,
  keepOldSessions: false,
  cleanupHintThreshold: 200,
};

function ensureConfigDir(): void {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
  } catch { /* directory exists or permission error — silent */ }
}

/** Parse a boolean env var */
function envBool(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/** Parse an integer env var */
function envInt(name: string): number | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

/** Load configuration, applying env var overrides on top of file */
export function loadConfig(): RewindConfig {
  let file: Partial<RewindConfig> = {};

  // Attempt to load from JSON file
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      file = JSON.parse(raw);
    }
  } catch {
    // Corrupt or unreadable file — use defaults
  }

  // Merge: defaults < file < env
  return {
    maxCheckpoints: envInt("PI_REWIND_MAX_CHECKPOINTS")
      ?? file.maxCheckpoints
      ?? DEFAULTS.maxCheckpoints,
    keepOldSessions: envBool("PI_REWIND_KEEP_OLD_SESSIONS")
      ?? file.keepOldSessions
      ?? DEFAULTS.keepOldSessions,
    cleanupHintThreshold: envInt("PI_REWIND_CLEANUP_HINT_THRESHOLD")
      ?? file.cleanupHintThreshold
      ?? DEFAULTS.cleanupHintThreshold,
  };
}

/** Write current config back to disk (used by cleanup command for persistence) */
export function saveConfig(config: RewindConfig): void {
  ensureConfigDir();
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  } catch {
    // Permission error — silent
  }
}
