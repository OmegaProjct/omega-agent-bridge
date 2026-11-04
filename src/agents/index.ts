import type { AgentAdapter, AgentResolver, EngineName } from "../types.js";
import { AgyAdapter } from "./agy.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";
import type { ProcessRunner } from "./processRunner.js";

export interface AdapterFactoryOptions {
  stateDir: string;
  agyBin?: string;
  claudeBin?: string;
  codexBin?: string;
  maxAccountsPerEngine?: number;
  cooldownMinutes?: number;
  runners?: Partial<Record<EngineName, ProcessRunner>>;
}

export function createAgentAdapter(engine: EngineName, options: AdapterFactoryOptions): AgentAdapter {
  switch (engine) {
    case "agy":
      return new AgyAdapter(options.agyBin, options.stateDir);
    case "claude":
      return new ClaudeAdapter({
        ...(options.claudeBin !== undefined ? { binary: options.claudeBin } : {}),
        stateDir: options.stateDir,
        ...(options.maxAccountsPerEngine !== undefined ? { maxAccountsPerEngine: options.maxAccountsPerEngine } : {}),
        ...(options.cooldownMinutes !== undefined ? { cooldownMinutes: options.cooldownMinutes } : {}),
        ...(options.runners?.claude ? { runner: options.runners.claude } : {})
      });
    case "codex":
      return new CodexAdapter({
        ...(options.codexBin !== undefined ? { binary: options.codexBin } : {}),
        stateDir: options.stateDir,
        ...(options.maxAccountsPerEngine !== undefined ? { maxAccountsPerEngine: options.maxAccountsPerEngine } : {}),
        ...(options.cooldownMinutes !== undefined ? { cooldownMinutes: options.cooldownMinutes } : {}),
        ...(options.runners?.codex ? { runner: options.runners.codex } : {})
      });
    default:
      throw new Error(`Unsupported engine: ${String(engine)}`);
  }
}

export function createAgentResolver(options: AdapterFactoryOptions): AgentResolver {
  const cache = new Map<EngineName, AgentAdapter>();
  return (engine: EngineName): AgentAdapter => {
    const existing = cache.get(engine);
    if (existing) {
      return existing;
    }
    const adapter = createAgentAdapter(engine, options);
    cache.set(engine, adapter);
    return adapter;
  };
}
