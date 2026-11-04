import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getAccountInfo,
  listConfiguredAccounts,
  resolveAccountHomes
} from "../src/agents/agy.js";
import { accountsDir } from "../src/schema.js";

const tempRoots: string[] = [];

async function createTempState(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omega-accounts-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  delete process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES;
  delete process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOME;
  await Promise.all(
    tempRoots.splice(0).map(async (target) => {
      await fs.rm(target, { recursive: true, force: true });
    })
  );
});

describe("accounts", () => {
  it("computes default accountsDir under stateDir", async () => {
    const stateDir = await createTempState();
    expect(accountsDir(stateDir)).toBe(path.join(stateDir, "accounts"));
  });

  it("resolves specific account when requested", async () => {
    const stateDir = await createTempState();
    const homes = await resolveAccountHomes("account-1", stateDir);
    expect(homes).toEqual([path.join(stateDir, "accounts", "account-1")]);
  });

  it("resolves absolute path when requested", async () => {
    const stateDir = await createTempState();
    const customPath = path.join(stateDir, "custom-profile");
    const homes = await resolveAccountHomes(customPath, stateDir);
    expect(homes).toEqual([customPath]);
  });

  it("returns [null] when no accounts exist and no env is set", async () => {
    const stateDir = await createTempState();
    const homes = await resolveAccountHomes(undefined, stateDir);
    expect(homes).toEqual([null]);
  });

  it("discovers all configured account directories sorted", async () => {
    const stateDir = await createTempState();
    const accDir = accountsDir(stateDir);
    await fs.mkdir(path.join(accDir, "account-2"), { recursive: true });
    await fs.mkdir(path.join(accDir, "account-1"), { recursive: true });
    await fs.mkdir(path.join(accDir, "account-3"), { recursive: true });

    const homes = await resolveAccountHomes(undefined, stateDir);
    expect(homes).toEqual([
      path.join(accDir, "account-1"),
      path.join(accDir, "account-2"),
      path.join(accDir, "account-3")
    ]);
  });

  it("prefers OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES over discovery", async () => {
    const stateDir = await createTempState();
    const accDir = accountsDir(stateDir);
    await fs.mkdir(path.join(accDir, "account-1"), { recursive: true });

    const custom1 = path.join(stateDir, "env-1");
    const custom2 = path.join(stateDir, "env-2");
    process.env.OMEGA_AGENT_BRIDGE_ACCOUNT_HOMES = `${custom1}${path.delimiter}${custom2}`;

    const homes = await resolveAccountHomes(undefined, stateDir);
    expect(homes).toEqual([path.resolve(custom1), path.resolve(custom2)]);
  });

  it("detects authentication status from google_accounts.json", async () => {
    const stateDir = await createTempState();
    const accDir = path.join(accountsDir(stateDir), "account-1");
    const geminiDir = path.join(accDir, ".gemini");
    await fs.mkdir(geminiDir, { recursive: true });
    await fs.writeFile(
      path.join(geminiDir, "google_accounts.json"),
      JSON.stringify({ active: "user1@example.com" }),
      "utf8"
    );

    const info = await getAccountInfo("account-1", stateDir);
    expect(info.id).toBe("account-1");
    expect(info.authenticated).toBe(true);
    expect(info.email).toBe("user1@example.com");
  });

  it("detects unauthenticated account when no credentials exist", async () => {
    const stateDir = await createTempState();
    const accDir = path.join(accountsDir(stateDir), "account-2");
    await fs.mkdir(accDir, { recursive: true });

    const info = await getAccountInfo("account-2", stateDir);
    expect(info.id).toBe("account-2");
    expect(info.authenticated).toBe(false);
    expect(info.email).toBeNull();
  });

  it("lists all configured accounts with status", async () => {
    const stateDir = await createTempState();
    const accRoot = accountsDir(stateDir);
    const acc1 = path.join(accRoot, "account-1", ".gemini");
    const acc2 = path.join(accRoot, "account-2");
    await fs.mkdir(acc1, { recursive: true });
    await fs.mkdir(acc2, { recursive: true });
    await fs.writeFile(
      path.join(acc1, "oauth_creds.json"),
      JSON.stringify({ token: "test" }),
      "utf8"
    );

    const accounts = await listConfiguredAccounts(stateDir);
    expect(accounts).toHaveLength(2);
    expect(accounts[0]?.id).toBe("account-1");
    expect(accounts[0]?.authenticated).toBe(true);
    expect(accounts[1]?.id).toBe("account-2");
    expect(accounts[1]?.authenticated).toBe(false);
  });
});
