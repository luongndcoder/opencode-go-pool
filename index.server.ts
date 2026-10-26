import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { classifyFailure } from "./server/failure";
import { ensurePiHome, KeyPool, maskKey } from "./server/pool";

/**
 * OpenCode Go key pool at the provider level: every agent whose provider the pool covers runs
 * on a key from the shared pool. When a turn fails on rate limit or auth, the key sits out and
 * the agent's next session open rides a fresh key — no per-agent account binding.
 *
 * Config lives in `$PASEO_HOME/opencode-go-pool/config.json`:
 *   { "keys": ["go-key-1", "go-key-2"], "providers": [], "autoRetry": true, "strict": false }
 * `providers` empty means every provider id mentioning "opencode". Re-read on every hook, so
 * editing the file needs no daemon restart. `strict` injects ONLY the pool key (test switch).
 *
 * Manual per-session switching: pin an agent to one key with the `opencode-go-pool.pin` RPC —
 * session_open honors the pin over LRU until `opencode-go-pool.unpin` clears it.
 */

const poolConfigSchema = z.object({
  keys: z.array(z.string().trim().min(1)).default([]),
  providers: z.array(z.string().trim().min(1)).default([]),
  autoRetry: z.boolean().default(true),
  strict: z.boolean().default(false),
});

interface PoolConfig {
  keys: string[];
  providers: string[];
  autoRetry: boolean;
  strict: boolean;
}

function paseoHome(): string {
  const raw = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  return raw.startsWith("~") ? path.join(homedir(), raw.slice(1)) : raw;
}

function poolDir(): string {
  return path.join(paseoHome(), "opencode-go-pool");
}

function readConfig(): PoolConfig {
  const configPath = path.join(poolDir(), "config.json");
  try {
    if (existsSync(configPath)) {
      return poolConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    }
  } catch (error) {
    console.error("[opencode-go-pool] invalid config.json:", error);
  }
  return { keys: [], providers: [], autoRetry: true, strict: false };
}

function log(message: string, ...rest: unknown[]): void {
  console.log(`[opencode-go-pool] ${message}`, ...rest);
}

/** Reopens the agent's session so the next `session_open` injects a fresh key. */
function reloadAgent(agentId: string): Promise<void> {
  const cli = process.env.PASEO_POOL_CLI ?? "paseo";
  return new Promise((resolve) => {
    execFile(
      cli,
      ["agent", "reload", agentId, "--json", "--home", paseoHome()],
      { timeout: 90_000, env: process.env },
      (error: Error | null, _stdout: string, stderr: string) => {
        if (error) {
          log(
            `reload of ${agentId} failed; the agent picks a new key on its next session open:`,
            `${stderr || error.message}`.trim().split("\n").slice(-1)[0],
          );
        } else {
          log(`reloaded ${agentId} onto a fresh pool key`);
        }
        resolve();
      },
    );
  });
}

/** Resolve a key given as the full secret or its `oc_s…1TCD`-style mask. */
function resolveKeyMask(pool: KeyPool, keyOrMask: string): string | null {
  return keyOrMask.includes("…") ? pool.resolveFullKey(keyOrMask) : keyOrMask;
}

/** The one auto-switch path: cool the key, then reopen the agent onto the next key. */
async function failoverAgent(
  pool: KeyPool,
  config: PoolConfig,
  agentId: string,
  key: string,
  kind: "window" | "auth",
): Promise<"cooled" | "no-key" | "unknown-agent" | "noop"> {
  const used = pool.keyForAgent(agentId);
  if (!used && !pool.pinnedKey(agentId)) return "unknown-agent";
  const until = pool.coolKey(key, kind);
  log(
    `key ${maskKey(key)} hit a ${kind} limit on ${agentId.slice(0, 8)}; cooling until ${new Date(until).toISOString()}`,
  );
  if (!config.autoRetry) return "cooled";
  const next = pool.pickKey(agentId);
  if (!next) {
    log("no pool key left to retry on; the next session open uses default credentials");
    return "no-key";
  }
  await reloadAgent(agentId);
  return "cooled";
}

export default function contribute(server: PluginServerContext) {
  /** Shared env injection for one picked key, by CLI family. */
  function injectFor(provider: string, agentId: string, env: Record<string, string>): Record<string, string> {
    const config = readConfig();
    if (config.keys.length === 0 || !poolCovers(config, provider)) {
      return env;
    }
    const pool = new KeyPool(poolDir(), config.keys, log);
    const picked = pool.pickKey(agentId);
    if (!picked) {
      log(
        `all ${config.keys.length} pool keys are cooling down; ${provider} runs on its default credentials`,
      );
      return env;
    }
    if (agentId) {
      pool.rememberAgent(agentId, picked.key);
    }
    const pinned = pool.pinnedKey(agentId);
    const family = familyOf(provider);
    log(
      `${agentId.slice(0, 8)} (${provider}, ${family}) runs on key ${maskKey(picked.key)}` +
        (pinned === picked.key ? " [pinned]" : "") +
        (config.keys.length > 1 ? ` (pool of ${config.keys.length})` : ""),
    );
    // OpenCode takes its auth through OPENCODE_AUTH_CONTENT; pi has no auth-content env, so the
    // pool redirects PI_CODING_AGENT_DIR to a per-key home whose auth.json carries the key.
    return family === "pi"
      ? { ...env, PI_CODING_AGENT_DIR: ensurePiHome(picked.key, log) }
      : { ...env, OPENCODE_AUTH_CONTENT: pool.authContent(picked.key, config.strict) };
  }

  // Older daemons may not know this hook; pi still gets covered at session_open there.
  try {
    server.before("agent.create", ({ request }) => {
      log(`agent.create hook: provider=${request.config.provider ?? "?"}`);
      const provider = request.config.provider ?? "";
      if (!provider) return;
      const env = injectFor(provider, "", request.env ?? {});
      return { ...request, env };
    });
  } catch (error) {
    log("agent.create hook unavailable on this daemon; pi coverage rides on session_open", error);
  }

  server.before("agent.session_open", ({ request }) => {
    log(`session_open hook: provider=${request.provider} reason=${request.reason}`);
    const config = readConfig();
    if (config.keys.length === 0 || !poolCovers(config, request.provider)) {
      return;
    }
    const env = injectFor(request.provider, request.agentId, request.env);
    return { ...request, env };
  });

  server.on("agent.turn_ended", async (event) => {
    if (event.outcome.kind !== "failed") return;
    log(
      `turn failed on ${event.agent.id.slice(0, 8)}: ${event.outcome.error.code ?? "no-code"} ${event.outcome.error.message.slice(0, 140)}`,
    );
    const config = readConfig();
    if (config.keys.length === 0) return;
    const pool = new KeyPool(poolDir(), config.keys, log);
    const used = pool.keyForAgent(event.agent.id);
    if (!used) return;
    const kind = classifyFailure(event.outcome.error.message, event.outcome.error.code);
    if (!kind) return;
    await failoverAgent(pool, config, event.agent.id, used.key, kind);
  });

  server.handle(
    {
      name: "opencode-go-pool.status",
      input: z.object({}).strict(),
      output: z.unknown(),
    },
    () => {
      const config = readConfig();
      const pool = new KeyPool(poolDir(), config.keys, log);
      return {
        keys: pool.status(),
        pins: pool.pins(),
        providers: config.providers,
        autoRetry: config.autoRetry,
        strict: config.strict,
      };
    },
  );

  server.handle(
    {
      name: "opencode-go-pool.pin",
      input: z.object({ agentId: z.string().min(1), key: z.string().min(1) }).strict(),
      output: z.object({ ok: z.boolean() }),
    },
    ({ agentId, key }) => {
      const config = readConfig();
      const pool = new KeyPool(poolDir(), config.keys, log);
      const resolved = resolveKeyMask(pool, key);
      const ok = resolved ? pool.pinAgent(agentId, resolved) : false;
      log(ok ? `pinned ${agentId.slice(0, 8)} to key ${maskKey(resolved!)}` : `pin failed for ${agentId.slice(0, 8)}: key not found`);
      return { ok };
    },
  );

  server.handle(
    {
      name: "opencode-go-pool.unpin",
      input: z.object({ agentId: z.string().min(1) }).strict(),
      output: z.object({ ok: z.boolean() }),
    },
    ({ agentId }) => {
      const config = readConfig();
      const pool = new KeyPool(poolDir(), config.keys, log);
      const ok = pool.unpinAgent(agentId);
      log(ok ? `unpinned ${agentId.slice(0, 8)}` : `unpin failed: ${agentId.slice(0, 8)} was not pinned`);
      return { ok };
    },
  );

  server.handle(
    {
      name: "opencode-go-pool.simulate-failure",
      input: z
        .object({ agentId: z.string().min(1), kind: z.enum(["window", "auth"]).default("window") })
        .strict(),
      output: z.object({ result: z.string() }),
    },
    async ({ agentId, kind }) => {
      const config = readConfig();
      const pool = new KeyPool(poolDir(), config.keys, log);
      const used = pool.keyForAgent(agentId);
      const key = used?.key ?? pool.pinnedKey(agentId);
      if (!key) return { result: "unknown-agent" };
      const result = await failoverAgent(pool, config, agentId, key, kind);
      return { result };
    },
  );

  return () => {};
}

function poolCovers(config: PoolConfig, provider: string): boolean {
  if (config.providers.length === 0) {
    // Token match: "copilot" contains "pi" and must not match by substring.
    const tokens = provider.toLowerCase().split(/[^a-z0-9]+/);
    return tokens.includes("opencode") || tokens.includes("pi");
  }
  return config.providers.includes(provider);
}

type CliFamily = "opencode" | "pi";

function familyOf(provider: string): CliFamily {
  const tokens = provider.toLowerCase().split(/[^a-z0-9]+/);
  return tokens.includes("pi") ? "pi" : "opencode";
}
