import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface PoolKeyState {
  key: string;
  /** Epoch ms until which the key sits out; 0 = active. */
  coolingUntil: number;
  coolingReason: string | null;
  lastUsedAt: number;
}

export interface PoolState {
  keys: PoolKeyState[];
  /** agentId -> key currently injected into that agent's sessions. */
  agents: Record<string, string>;
  /** agentId -> key the user pinned; session_open honors it over LRU. */
  pins: Record<string, string>;
}

const WINDOW_COOLDOWN_MS = 60 * 60_000;
const AUTH_COOLDOWN_MS = 24 * 60 * 60_000;

/** The user's own OpenCode credentials; the pool key rides on top of them. */
export function mainAuthPath(): string {
  return path.join(homedir(), ".local", "share", "opencode", "auth.json");
}

/** Pi keeps its keys in `<agentDir>/auth.json`; `PI_CODING_AGENT_DIR` relocates the whole dir. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.replace(/^~/, homedir()) ?? path.join(homedir(), ".pi", "agent");
}

function piHomeId(key: string): string {
  return createHash("sha1").update(key).digest("hex").slice(0, 10);
}

/**
 * Per-key Pi home: symlinks every entry of the real agent dir except auth.json (which becomes
 * a merged per-key file), so models, extensions and settings stay shared while the key rotates.
 * Returns the dir to hand to pi via PI_CODING_AGENT_DIR. Idempotent per key.
 */
export function ensurePiHome(key: string, log: (message: string, ...rest: unknown[]) => void): string {
  const real = piAgentDir();
  const baseDir = process.env.PASEO_GO_POOL_DIR?.replace(/^~/, homedir())
    ?? path.join(homedir(), ".paseo", "opencode-go-pool");
  const home = path.join(baseDir, "pi-homes", piHomeId(key));
  mkdirSync(home, { recursive: true });
  let entries: string[] = [];
  try {
    entries = readdirSync(real);
  } catch (error) {
    log("could not read the pi agent dir; pi sessions keep their default home", error);
    return real;
  }
  for (const entry of entries) {
    if (entry === "auth.json") continue;
    const target = path.join(home, entry);
    if (existsSync(target)) continue;
    try {
      symlinkSync(path.join(real, entry), target);
    } catch (error) {
      log(`could not symlink pi dir entry ${entry}`, error);
    }
  }
  // Merged per-key auth: the pool key wins for opencode-go; the user's other providers stay.
  let merged: Record<string, unknown> = {};
  try {
    merged = JSON.parse(readFileSync(path.join(real, "auth.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    log("could not read the pi auth.json; injecting only the pool key", error);
  }
  merged["opencode-go"] = { type: "api_key", key };
  writeFileSync(path.join(home, "auth.json"), JSON.stringify(merged, null, 2), { mode: 0o600 });
  return home;
}

/** Drops a per-key pi home (called when a key leaves the pool). */
export function removePiHome(key: string): void {
  rmSync(path.join(homedir(), ".paseo", "opencode-go-pool", "pi-homes", piHomeId(key)), { recursive: true, force: true });
}

export class KeyPool {
  private readonly statePath: string;
  private state: PoolState = { keys: [], agents: {}, pins: {} };

  constructor(
    stateDir: string,
    private readonly configuredKeys: readonly string[],
    private readonly log: (message: string, ...rest: unknown[]) => void,
  ) {
    this.statePath = path.join(stateDir, "state.json");
    this.load();
    // Config is the source of truth for WHICH keys exist; the state file only tracks
    // cooldowns and stickiness, so keys removed from config drop out on reload.
    const known = new Map(this.state.keys.map((entry) => [entry.key, entry]));
    this.state.keys = this.configuredKeys.map((key) => {
      const existing = known.get(key);
      return (
        existing ?? { key, coolingUntil: 0, coolingReason: null, lastUsedAt: 0 }
      );
    });
    this.save();
  }

  covers(provider: string, providers: readonly string[]): boolean {
    if (providers.length === 0) {
      // No explicit list: serve every provider whose id mentions opencode.
      return provider.toLowerCase().includes("opencode");
    }
    return providers.includes(provider);
  }

  private load(): void {
    try {
      if (existsSync(this.statePath)) {
        const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as PoolState;
        if (Array.isArray(parsed.keys) && typeof parsed.agents === "object") {
          this.state = { ...parsed, pins: parsed.pins ?? {} };
        }
      }
    } catch (error) {
      this.log("could not read pool state; starting fresh", error);
    }
  }

  private save(): void {
    try {
      mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
      writeFileSync(this.statePath, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    } catch (error) {
      this.log("could not write pool state", error);
    }
  }

  /** The least-recently-used key that is not cooling down; null when all are out. */
  pickKey(agentId?: string): PoolKeyState | null {
    const now = Date.now();
    const active = this.state.keys.filter((entry) => entry.coolingUntil <= now);
    if (active.length === 0) return null;
    // A manual pin wins over LRU while its key is active.
    const pin = agentId ? this.state.pins[agentId] : undefined;
    const pinned = pin ? active.find((entry) => entry.key === pin) : undefined;
    const picked = pinned ?? active.reduce((best, entry) =>
      entry.lastUsedAt < best.lastUsedAt ? entry : best,
    );
    picked.lastUsedAt = now;
    this.save();
    return picked;
  }

  /** Manual per-session account switch: pin an agent to one key. */
  pinAgent(agentId: string, key: string): boolean {
    if (!this.state.keys.some((entry) => entry.key === key)) return false;
    this.state.pins[agentId] = key;
    this.save();
    return true;
  }

  unpinAgent(agentId: string): boolean {
    if (!this.state.pins[agentId]) return false;
    delete this.state.pins[agentId];
    this.save();
    return true;
  }

  /** Full key for a `oc_s…1TCD`-style mask, or null. */
  resolveFullKey(mask: string): string | null {
    return this.state.keys.find((entry) => maskKey(entry.key) === mask)?.key ?? null;
  }

  pinnedKey(agentId: string): string | null {
    return this.state.pins[agentId] ?? null;
  }

  /**
   * OpenCode Go credentials the agent runs on. Default merges the user's own providers so they
   * keep working; `strict` injects ONLY the pool key — the test switch that proves the injected
   * environment reaches the opencode process (a broken key then fails loudly).
   */
  authContent(key: string, strict = false): string {
    if (strict) {
      return JSON.stringify({ "opencode-go": { type: "api", key } });
    }
    let main: Record<string, unknown> = {};
    try {
      if (existsSync(mainAuthPath())) {
        main = JSON.parse(readFileSync(mainAuthPath(), "utf8")) as Record<string, unknown>;
      }
    } catch (error) {
      this.log("could not read main auth.json; injecting only the pool key", error);
    }
    const merged = { ...main, "opencode-go": { type: "api", key } };
    return JSON.stringify(merged);
  }

  rememberAgent(agentId: string, key: string): void {
    this.state.agents[agentId] = key;
    this.save();
  }

  forgetAgent(agentId: string): void {
    if (this.state.agents[agentId]) {
      delete this.state.agents[agentId];
      this.save();
    }
  }

  keyForAgent(agentId: string): PoolKeyState | null {
    const key = this.state.agents[agentId];
    if (!key) return null;
    return this.state.keys.find((entry) => entry.key === key) ?? null;
  }

  /** Puts a key on the bench. Rate limits cool for a window; auth failures cool for a day. */
  coolKey(key: string, kind: "window" | "auth"): number {
    const entry = this.state.keys.find((candidate) => candidate.key === key);
    if (!entry) return 0;
    const ms = kind === "auth" ? AUTH_COOLDOWN_MS : WINDOW_COOLDOWN_MS;
    entry.coolingUntil = Date.now() + ms;
    entry.coolingReason = kind;
    this.save();
    return entry.coolingUntil;
  }

  /** Clears a key's cooldown (manual unblock or the window passed and it proved healthy). */
  reviveKey(key: string): void {
    const entry = this.state.keys.find((candidate) => candidate.key === key);
    if (!entry) return;
    entry.coolingUntil = 0;
    entry.coolingReason = null;
    this.save();
  }

  hasActiveKey(): boolean {
    const now = Date.now();
    return this.state.keys.some((entry) => entry.coolingUntil <= now);
  }

  status(): Array<{ keyMasked: string; coolingUntil: number; coolingReason: string | null; lastUsedAt: number }> {
    return this.state.keys.map((entry) => ({
      keyMasked: maskKey(entry.key),
      coolingUntil: entry.coolingUntil,
      coolingReason: entry.coolingUntil > Date.now() ? entry.coolingReason : null,
      lastUsedAt: entry.lastUsedAt,
    }));
  }

  pins(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.state.pins).map(([agent, key]) => [agent, maskKey(key)]),
    );
  }
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
