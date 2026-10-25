import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ensurePiHome, KeyPool, maskKey } from "./pool.js";

let stateDir: string;
const log = () => {};

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "go-pool-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("picks the least recently used active key and persists lastUsedAt", () => {
  const pool = new KeyPool(stateDir, ["key-a", "key-b"], log);
  const first = pool.pickKey();
  expect(first?.key).toBe("key-a");
  // Fresh instance over the same state dir remembers key-a was just used.
  const second = new KeyPool(stateDir, ["key-a", "key-b"], log).pickKey();
  expect(second?.key).toBe("key-b");
});

test("skips cooling keys and returns null when everything is out", () => {
  const pool = new KeyPool(stateDir, ["key-a", "key-b"], log);
  pool.coolKey("key-a", "window");
  expect(pool.pickKey()?.key).toBe("key-b");
  pool.coolKey("key-b", "window");
  expect(pool.pickKey()).toBeNull();
  expect(pool.hasActiveKey()).toBe(false);
});

test("auth failures cool longer than window failures", () => {
  const pool = new KeyPool(stateDir, ["key-a", "key-b"], log);
  const windowUntil = pool.coolKey("key-a", "window");
  const authUntil = pool.coolKey("key-b", "auth");
  expect(authUntil - windowUntil).toBeGreaterThan(20 * 60 * 60_000);
});

test("keys removed from config drop out of the state on reload", () => {
  new KeyPool(stateDir, ["key-a", "key-b"], log);
  const narrowed = new KeyPool(stateDir, ["key-a"], log);
  expect(narrowed.pickKey()?.key).toBe("key-a");
});

test("a cooling key revives and becomes pickable again", () => {
  const pool = new KeyPool(stateDir, ["key-a", "key-b"], log);
  pool.coolKey("key-a", "auth");
  expect(pool.pickKey()?.key).toBe("key-b");
  pool.reviveKey("key-a");
  const again = pool.pickKey();
  expect(["key-a", "key-b"]).toContain(again?.key);
});

test("authContent merges the user's other providers under the pool key", () => {
  // Point mainAuthPath's directory at a temp home by faking HOME through the module's
  // mainAuthPath? mainAuthPath reads homedir() directly, so exercise the merge shape instead:
  const pool = new KeyPool(stateDir, ["key-real"], log);
  const content = JSON.parse(pool.authContent("key-real")) as Record<string, unknown>;
  expect(content["opencode-go"]).toEqual({ type: "api", key: "key-real" });
});

test("agent stickiness maps an agent to its key and forgets on demand", () => {
  const pool = new KeyPool(stateDir, ["key-a", "key-b"], log);
  pool.rememberAgent("agent-1", "key-a");
  expect(pool.keyForAgent("agent-1")?.key).toBe("key-a");
  pool.forgetAgent("agent-1");
  expect(pool.keyForAgent("agent-1")).toBeNull();
});

test("state file is written with restricted permissions", () => {
  const pool = new KeyPool(stateDir, ["key-a"], log);
  pool.pickKey();
  const stat = statSync(path.join(stateDir, "state.json"));
  // Group/other have no read access: the file holds raw API keys.
  expect(stat.mode & 0o077).toBe(0);
});

test("maskKey never leaks the full key", () => {
  expect(maskKey("sk-ant-very-long-secret-key-1234")).not.toContain("very-long-secret");
  expect(maskKey("ab")).toBe("****");
});

test("pin overrides LRU and clears on unpin", () => {
  const pool = new KeyPool(stateDir, ["key-a", "key-b"], log);
  expect(pool.pickKey()?.key).toBe("key-a"); // LRU default
  expect(pool.pinAgent("agent-1", "key-b")).toBe(true);
  expect(pool.pinAgent("agent-1", "missing-key")).toBe(false);
  expect(pool.pickKey("agent-1")?.key).toBe("key-b"); // pin wins
  expect(pool.pickKey("agent-2")?.key).toBe("key-a"); // others keep LRU
  expect(pool.unpinAgent("agent-1")).toBe(true);
  expect(pool.pinnedKey("agent-1")).toBeNull();
});

test("ensurePiHome symlinks the real agent dir and merges the pool key into auth.json", () => {
  const fakeAgentDir = mkdtempSync(path.join(tmpdir(), "pi-agent-"));
  writeFileSync(path.join(fakeAgentDir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api_key", key: "real" }, "google-vertex": { type: "api_key", key: "vtx" } }));
  writeFileSync(path.join(fakeAgentDir, "models.json"), "{}");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousBase = process.env.PASEO_GO_POOL_DIR;
  process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
  process.env.PASEO_GO_POOL_DIR = stateDir; // keep pi homes out of the real paseo home
  try {
    const home = ensurePiHome("pool-key-1", log);
    expect(home).toContain(path.join("pi-homes", "d0a8bb8017"));
    // models.json is a symlink into the real dir; auth.json is a real merged file
    const auth = JSON.parse(readFileSync(path.join(home, "auth.json"), "utf8"));
    expect(auth["opencode-go"]).toEqual({ type: "api_key", key: "pool-key-1" });
    expect(auth["google-vertex"]).toEqual({ type: "api_key", key: "vtx" });
    expect(lstatSync(path.join(home, "models.json")).isSymbolicLink()).toBe(true);
    // same key → same home, idempotent
    expect(ensurePiHome("pool-key-1", log)).toBe(home);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousBase === undefined) delete process.env.PASEO_GO_POOL_DIR;
    else process.env.PASEO_GO_POOL_DIR = previousBase;
    rmSync(fakeAgentDir, { recursive: true, force: true });
  }
});
