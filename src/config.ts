import fs from "node:fs/promises";
import path from "node:path";

import type { EngineName } from "./types.js";

export interface EngineConfig {
  enabled: boolean;
  binary: string | null;
}

export interface BridgeConfig {
  version: 1;
  maxAccountsPerEngine: number;
  rotation: "least-recently-used";
  cooldownMinutes: number;
  engines: Record<EngineName, EngineConfig>;
}

export const DEFAULT_CONFIG: BridgeConfig = {
  version: 1,
  maxAccountsPerEngine: 20,
  rotation: "least-recently-used",
  cooldownMinutes: 15,
  engines: {
    agy: { enabled: false, binary: null },
    claude: { enabled: false, binary: null },
    codex: { enabled: false, binary: null }
  }
};

export function configPath(stateDir: string): string {
  return path.join(stateDir, "config.json");
}

export async function loadConfig(stateDir: string): Promise<BridgeConfig> {
  try {
    const raw = await fs.readFile(configPath(stateDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      engines: {
        agy: { ...DEFAULT_CONFIG.engines.agy, ...(parsed.engines?.agy ?? {}) },
        claude: { ...DEFAULT_CONFIG.engines.claude, ...(parsed.engines?.claude ?? {}) },
        codex: { ...DEFAULT_CONFIG.engines.codex, ...(parsed.engines?.codex ?? {}) }
      }
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export async function saveConfig(stateDir: string, config: BridgeConfig): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  const target = configPath(stateDir);
  const temp = `${target}.tmp.${Date.now()}`;
  await fs.writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  try {
    await fs.rename(temp, target);
  } catch {
    await fs.copyFile(temp, target);
    await fs.unlink(temp).catch(() => {});
  }
}

export function engineBinary(
  engine: EngineName,
  config: BridgeConfig,
  overrides: Partial<Record<EngineName, string | undefined>> = {}
): string {
  const override = overrides[engine];
  if (override && override.trim()) {
    return override.trim();
  }
  const configured = config.engines[engine]?.binary;
  if (configured && configured.trim()) {
    return configured.trim();
  }
  const envName = engine === "agy" ? "AGY_BIN" : engine === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";
  const fromEnv = process.env[envName];
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return engine;
}
