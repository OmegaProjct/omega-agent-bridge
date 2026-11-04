import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ options: null as { windowsHide?: boolean; stdio?: unknown } | null }));

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (_binary: string, _args: string[], options?: { windowsHide?: boolean; stdio?: unknown }) => {
      state.options = options ?? null;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    }
  };
});

import { launchInteractiveLogin } from "../src/agents/agy.js";

const tempRoots: string[] = [];

afterEach(async () => {
  state.options = null;
  await Promise.all(tempRoots.splice(0).map(target => fs.rm(target, { recursive: true, force: true })));
});

describe("Windows child windows", () => {
  it("hides the console when launching an interactive account login", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "omega-bridge-window-test-"));
    tempRoots.push(stateDir);

    await expect(launchInteractiveLogin("account-1", "agy", stateDir)).resolves.toBe(0);
    expect(state.options?.windowsHide).toBe(true);
  });
});
