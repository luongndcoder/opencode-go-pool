import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { classifyFailure } from "./server/failure";
import { KeyPool, maskKey } from "./server/pool";

/**
 * OpenCode Go key pool at the provider level: every agent whose provider the pool covers runs
 * on a key from the shared pool. When a turn fails on rate limit or auth, the key sits out and
 * the agent's next session open rides a fresh key — no per-agent account binding.
 *
 * Config lives in `$PASEO_HOME/opencode-go-pool/config.json`:
 *   { "keys": ["go-key-1", "go-key-2"], "providers": [], "autoRetry": true }
 * `providers` empty means every provider id mentioning "opencode". Re-read on every hook, so
 * editing the file needs no daemon restart.
 */

const poolConfigSchema = z.object({
  keys: z.array(z.string().trim().min(1)).default([]),
  providers: z.array(z.string().trim().min(1)).default([]),
  autoRetry: z.boolean().default(true),
});

interface PoolConfig {
  keys: string[];
  providers: string[];
  autoRetry: boolean;
}

function paseoHome(): string {
  const raw = process.env.PASEO_HOME ?? path.join(homedir(), ".paseo");
  return raw.startsWith("~") ? path.join(homedir(), raw.slice(1)) : raw;
}

function readConfig(): PoolConfig {
  const configPath = path.join(paseoHome(), "opencode-go-pool", "config.json");
  try {
    if (existsSync(configPath)) {
      return poolConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    }
  } catch (error) {
    console.error("[opencode-go-pool] invalid config.json:", error);
  }
  return { keys: [], providers: [], autoRetry: true };
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

export default function contribute(server: PluginServerContext) {
  server.before("agent.session_open", ({ request }) => {
    const config = readConfig();
    if (config.keys.length === 0 || !poolCovers(config, request.provider)) {
      return;
    }
    const pool = new KeyPool(poolDir(), config.keys, log);
    const picked = pool.pickKey();
    if (!picked) {
      log(
        `all ${config.keys.length} pool keys are cooling down; ${request.provider} runs on its default credentials`,
      );
      return;
    }
    pool.forgetAgent(request.agentId);
    pool.rememberAgent(request.agentId, picked.key);
    log(
      `${request.agentId.slice(0, 8)} (${request.provider}) runs on key ${maskKey(picked.key)}` +
        (config.keys.length > 1 ? ` (pool of ${config.keys.length})` : ""),
    );
    return {
      ...request,
      env: { ...request.env, OPENCODE_AUTH_CONTENT: pool.authContent(picked.key) },
    };
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
    const until = pool.coolKey(used.key, kind);
    log(
      `key ${maskKey(used.key)} hit a ${kind} limit on ${event.agent.id.slice(0, 8)}; cooling until ${new Date(until).toISOString()}`,
    );
    if (!config.autoRetry) return;
    const next = pool.pickKey();
    if (!next) {
      log("no pool key left to retry on; the next session open uses default credentials");
      return;
    }
    await reloadAgent(event.agent.id);
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
        providers: config.providers,
        autoRetry: config.autoRetry,
      };
    },
  );

  return () => {};
}

function poolDir(): string {
  return path.join(paseoHome(), "opencode-go-pool");
}

function poolCovers(config: PoolConfig, provider: string): boolean {
  if (config.providers.length === 0) {
    return provider.toLowerCase().includes("opencode");
  }
  return config.providers.includes(provider);
}
