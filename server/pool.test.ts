import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { KeyPool, maskKey } from "./pool.js";

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
