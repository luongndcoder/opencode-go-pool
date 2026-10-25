import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
}

const WINDOW_COOLDOWN_MS = 60 * 60_000;
const AUTH_COOLDOWN_MS = 24 * 60 * 60_000;

/** The user's own OpenCode credentials; the pool key rides on top of them. */
export function mainAuthPath(): string {
  return path.join(homedir(), ".local", "share", "opencode", "auth.json");
}

export class KeyPool {
  private readonly statePath: string;
  private state: PoolState = { keys: [], agents: {} };

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
          this.state = parsed;
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
  pickKey(): PoolKeyState | null {
    const now = Date.now();
    const active = this.state.keys.filter((entry) => entry.coolingUntil <= now);
    if (active.length === 0) return null;
    const picked = active.reduce((best, entry) =>
      entry.lastUsedAt < best.lastUsedAt ? entry : best,
    );
    picked.lastUsedAt = now;
    this.save();
    return picked;
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
}

export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
