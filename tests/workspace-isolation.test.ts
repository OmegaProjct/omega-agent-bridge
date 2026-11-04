import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyIntegration,
  cleanupIsolatedWorkspace,
  createIsolatedWorkspace,
  detectIntegrationConflicts,
  detectWorkerChanges,
  hashFile,
  isDependencyFile,
  isProtectedPath,
  takeWorkspaceSnapshot,
  type WorkerChangeset
} from "../src/workspace-isolation.js";
import { buildPeerReviewPrompt } from "../src/prompts.js";
import type { BridgeJob, BridgeRun } from "../src/types.js";

const tempRoots: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omega-iso-test-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
    })
  );
});

describe("workspace-isolation", () => {
  it("snapshots workspace with text and binary files, ignoring .git, node_modules, and secrets", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    // Text file
    await fs.writeFile(path.join(workspace, "index.ts"), "export const x = 1;\n", "utf8");

    // Binary file (arbitrary bytes including 0x00, 0xFF)
    const binaryBytes = Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    await fs.writeFile(path.join(workspace, "image.png"), binaryBytes);

    // .git directory (should be ignored by snapshot)
    const gitDir = path.join(workspace, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");

    // node_modules directory (should be ignored by snapshot)
    const nmDir = path.join(workspace, "node_modules", "some-pkg");
    await fs.mkdir(nmDir, { recursive: true });
    await fs.writeFile(path.join(nmDir, "index.js"), "module.exports = {};\n", "utf8");

    // .env file (secret - should be ignored by snapshot)
    await fs.writeFile(path.join(workspace, ".env"), "API_KEY=secret\n", "utf8");
    await fs.writeFile(path.join(workspace, ".env.production"), "SECRET=prod\n", "utf8");

    const snapshot = await takeWorkspaceSnapshot(workspace);
    expect(snapshot.has("index.ts")).toBe(true);
    expect(snapshot.has("image.png")).toBe(true);
    expect(snapshot.has(".git/HEAD")).toBe(false);
    expect(snapshot.has("node_modules/some-pkg/index.js")).toBe(false);
    expect(snapshot.has(".env")).toBe(false);
    expect(snapshot.has(".env.production")).toBe(false);

    // Verify binary hash matches
    const expectedBinaryHash = (await hashFile(path.join(workspace, "image.png"))).hash;
    expect(snapshot.get("image.png")?.hash).toBe(expectedBinaryHash);
    expect(snapshot.get("image.png")?.size).toBe(binaryBytes.length);
  });

  it("creates an isolated workspace preserving dirty/untracked files while excluding node_modules, .git, and secrets", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const isolated = path.join(root, "iso-worker-1");
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(path.join(workspace, "committed.ts"), "const a = 1;", "utf8");
    await fs.writeFile(path.join(workspace, "dirty_uncommitted.ts"), "const b = 'dirty';", "utf8");
    await fs.writeFile(path.join(workspace, "untracked.md"), "# Untracked note", "utf8");

    // node_modules in live workspace
    const nmDir = path.join(workspace, "node_modules");
    await fs.mkdir(nmDir, { recursive: true });
    await fs.writeFile(path.join(nmDir, "package.json"), "{}", "utf8");

    // Secrets and .git in live workspace
    await fs.writeFile(path.join(workspace, ".env"), "SECRET_TOKEN=xyz", "utf8");
    const gitDir = path.join(workspace, ".git");
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(gitDir, "config"), "[core]\n", "utf8");

    await createIsolatedWorkspace(workspace, isolated);

    // Verify user files were copied
    expect(await fs.readFile(path.join(isolated, "committed.ts"), "utf8")).toBe("const a = 1;");
    expect(await fs.readFile(path.join(isolated, "dirty_uncommitted.ts"), "utf8")).toBe("const b = 'dirty';");
    expect(await fs.readFile(path.join(isolated, "untracked.md"), "utf8")).toBe("# Untracked note");

    // Verify shared writable node_modules symlink/junction was NOT created
    expect(await fs.access(path.join(isolated, "node_modules")).then(() => true).catch(() => false)).toBe(false);

    // Verify secrets and git internals are excluded from worker workspace
    expect(await fs.access(path.join(isolated, ".env")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(isolated, ".git")).then(() => true).catch(() => false)).toBe(false);

    await cleanupIsolatedWorkspace(isolated);
    expect(await fs.access(isolated).then(() => true).catch(() => false)).toBe(false);

    // Live node_modules, .env, and .git must remain intact after cleanup
    expect(await fs.readFile(path.join(workspace, "node_modules", "package.json"), "utf8")).toBe("{}");
    expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET_TOKEN=xyz");
    expect(await fs.readFile(path.join(workspace, ".git", "config"), "utf8")).toBe("[core]\n");
  });

  it("detects modified, added, and deleted files in worker changeset", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const isolated = path.join(root, "iso-worker");
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(path.join(workspace, "file1.txt"), "original 1", "utf8");
    await fs.writeFile(path.join(workspace, "file2.txt"), "original 2", "utf8");
    await fs.writeFile(path.join(workspace, "to_delete.txt"), "delete me", "utf8");

    const baseline = await takeWorkspaceSnapshot(workspace);
    await createIsolatedWorkspace(workspace, isolated);

    // Worker modifies file1, adds file3, deletes to_delete.txt
    await fs.writeFile(path.join(isolated, "file1.txt"), "modified 1", "utf8");
    await fs.writeFile(path.join(isolated, "file3.txt"), "created 3", "utf8");
    await fs.rm(path.join(isolated, "to_delete.txt"));

    const changeset = await detectWorkerChanges(baseline, isolated);
    expect(changeset.modifiedFiles).toEqual(["file1.txt"]);
    expect(changeset.addedFiles).toEqual(["file3.txt"]);
    expect(changeset.deletedFiles).toEqual(["to_delete.txt"]);
  });

  it("detects intra-worker conflicts when concurrent workers touch the same file", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const iso1 = path.join(root, "iso-1");
    const iso2 = path.join(root, "iso-2");
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(path.join(workspace, "shared.ts"), "export const val = 0;", "utf8");
    const baseline = await takeWorkspaceSnapshot(workspace);

    await createIsolatedWorkspace(workspace, iso1);
    await createIsolatedWorkspace(workspace, iso2);

    // Worker 1 modifies shared.ts to version 1
    await fs.writeFile(path.join(iso1, "shared.ts"), "export const val = 1;", "utf8");
    // Worker 2 modifies shared.ts to version 2
    await fs.writeFile(path.join(iso2, "shared.ts"), "export const val = 2;", "utf8");

    const cs1 = await detectWorkerChanges(baseline, iso1);
    const cs2 = await detectWorkerChanges(baseline, iso2);

    const liveSnapshot = await takeWorkspaceSnapshot(workspace);
    const report = detectIntegrationConflicts(baseline, liveSnapshot, [cs1, cs2]);

    expect(report.hasConflict).toBe(true);
    expect(report.conflicts.some((c) => c.includes("Intra-worker conflict") && c.includes("shared.ts"))).toBe(true);
  });

  it("detects conflict when live workspace was modified during execution (external or uncommitted drift)", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const iso1 = path.join(root, "iso-1");
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(path.join(workspace, "config.json"), '{"v": 1}', "utf8");
    const baseline = await takeWorkspaceSnapshot(workspace);

    await createIsolatedWorkspace(workspace, iso1);
    await fs.writeFile(path.join(iso1, "config.json"), '{"v": 2}', "utf8");
    const cs1 = await detectWorkerChanges(baseline, iso1);

    // In the meantime, external user edits config.json in live workspace!
    await fs.writeFile(path.join(workspace, "config.json"), '{"v": 99}', "utf8");
    const liveSnapshot = await takeWorkspaceSnapshot(workspace);

    const report = detectIntegrationConflicts(baseline, liveSnapshot, [cs1]);
    expect(report.hasConflict).toBe(true);
    expect(report.conflicts.some((c) => c.includes("Live workspace conflict") && c.includes("config.json"))).toBe(true);
  });

  it("prevents overwriting untracked user files created during run", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const iso1 = path.join(root, "iso-1");
    await fs.mkdir(workspace, { recursive: true });

    const baseline = await takeWorkspaceSnapshot(workspace);
    await createIsolatedWorkspace(workspace, iso1);

    // Worker 1 creates new_file.txt
    await fs.writeFile(path.join(iso1, "new_file.txt"), "worker content", "utf8");
    const cs1 = await detectWorkerChanges(baseline, iso1);

    // User also created untracked new_file.txt in live workspace!
    await fs.writeFile(path.join(workspace, "new_file.txt"), "user untracked content", "utf8");
    const liveSnapshot = await takeWorkspaceSnapshot(workspace);

    const report = detectIntegrationConflicts(baseline, liveSnapshot, [cs1]);
    expect(report.hasConflict).toBe(true);
    expect(report.conflicts.some((c) => c.includes("untracked user file") && c.includes("new_file.txt"))).toBe(true);
  });

  it("safely applies non-conflicting changes with byte-level fidelity for binary files", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const iso1 = path.join(root, "iso-1");
    const iso2 = path.join(root, "iso-2");
    await fs.mkdir(workspace, { recursive: true });

    // Existing live files: uncommitted text file and untouched untracked file
    await fs.writeFile(path.join(workspace, "untouched_user_note.txt"), "do not touch me", "utf8");
    await fs.writeFile(path.join(workspace, "file_a.ts"), "const a = 1;", "utf8");
    await fs.writeFile(path.join(workspace, "file_b.ts"), "const b = 1;", "utf8");

    const baseline = await takeWorkspaceSnapshot(workspace);
    await createIsolatedWorkspace(workspace, iso1);
    await createIsolatedWorkspace(workspace, iso2);

    // Worker 1 updates file_a.ts and creates binary file
    const binaryData = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01, 0x02, 0xFF]);
    await fs.writeFile(path.join(iso1, "file_a.ts"), "const a = 2;", "utf8");
    await fs.writeFile(path.join(iso1, "sample.bin"), binaryData);

    // Worker 2 updates file_b.ts
    await fs.writeFile(path.join(iso2, "file_b.ts"), "const b = 2;", "utf8");

    const cs1 = await detectWorkerChanges(baseline, iso1);
    const cs2 = await detectWorkerChanges(baseline, iso2);

    const liveSnapshot = await takeWorkspaceSnapshot(workspace);
    const report = detectIntegrationConflicts(baseline, liveSnapshot, [cs1, cs2]);
    expect(report.hasConflict).toBe(false);

    // Apply integration
    await applyIntegration(workspace, [cs1, cs2], baseline);

    // Verify live workspace
    expect(await fs.readFile(path.join(workspace, "file_a.ts"), "utf8")).toBe("const a = 2;");
    expect(await fs.readFile(path.join(workspace, "file_b.ts"), "utf8")).toBe("const b = 2;");
    const readBinary = await fs.readFile(path.join(workspace, "sample.bin"));
    expect(Buffer.compare(readBinary, binaryData)).toBe(0);

    // Verify untouched user file was strictly preserved
    expect(await fs.readFile(path.join(workspace, "untouched_user_note.txt"), "utf8")).toBe("do not touch me");
  });

  // --- FAULT INJECTION TESTS ---

  it("fails closed on unreadable files/directories during snapshot and worker changes detection without treating unreadable files as deletions", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "readable.ts"), "const x = 1;", "utf8");
    await fs.writeFile(path.join(workspace, "locked.ts"), "const y = 2;", "utf8");

    const baseline = await takeWorkspaceSnapshot(workspace);
    expect(baseline.has("readable.ts")).toBe(true);
    expect(baseline.has("locked.ts")).toBe(true);

    const isolated = path.join(root, "isolated");
    await createIsolatedWorkspace(workspace, isolated);

    // Fault injection: simulate locked.ts being unreadable (e.g. permission error / IO lock)
    const originalReadFile = fs.readFile;
    const readFileSpy = vi.spyOn(fs, "readFile").mockImplementation(async (filePath, options) => {
      if (typeof filePath === "string" && filePath.includes("locked.ts")) {
        const err = new Error("EACCES: permission denied, open 'locked.ts'") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return originalReadFile(filePath, options);
    });

    try {
      // 1. Snapshot must fail closed on IO error
      await expect(takeWorkspaceSnapshot(isolated)).rejects.toThrow("EACCES");

      // 2. detectWorkerChanges must fail closed and NEVER misinterpret unreadable file as a deletion
      await expect(detectWorkerChanges(baseline, isolated)).rejects.toThrow("EACCES");
    } finally {
      readFileSpy.mockRestore();
    }
  });

  it("rejects symlink and junction path traversal and newly created symlinks in applyIntegration", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const isolated = path.join(root, "iso-worker");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(isolated, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    await fs.writeFile(path.join(outsideDir, "secret_outside.txt"), "forbidden content", "utf8");
    await fs.writeFile(path.join(workspace, "valid.txt"), "valid", "utf8");

    // 1. Worker created a directory junction or symlink pointing outside
    const linkPath = path.join(isolated, "symlink_dir");
    const symlinkType = os.platform() === "win32" ? "junction" : "dir";
    await fs.symlink(outsideDir, linkPath, symlinkType);

    const csWithSymlink: WorkerChangeset = {
      jobId: "worker-symlink",
      isolatedWorkspace: isolated,
      modifiedFiles: [],
      addedFiles: ["symlink_dir"],
      deletedFiles: [],
      fileSnapshots: new Map()
    };

    // applyIntegration must reject newly created symlinks
    await expect(applyIntegration(workspace, [csWithSymlink])).rejects.toThrow(/Security violation.*symlink/i);

    // 2. Worker attempts path traversal with relative path containing ..
    const csTraversal: WorkerChangeset = {
      jobId: "worker-traversal",
      isolatedWorkspace: isolated,
      modifiedFiles: [],
      addedFiles: ["../outside.txt"],
      deletedFiles: [],
      fileSnapshots: new Map()
    };

    await expect(applyIntegration(workspace, [csTraversal])).rejects.toThrow(/Security violation.*traversal/i);

    // Verify live workspace remains completely untouched
    expect(await fs.access(path.join(workspace, "symlink_dir")).then(() => true).catch(() => false)).toBe(false);
    expect(await fs.access(path.join(workspace, "outside.txt")).then(() => true).catch(() => false)).toBe(false);
  });

  it("retains backups and preserves user data if rollback fails during integration", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const isolated = path.join(root, "iso-worker");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(isolated, { recursive: true });

    // Live workspace has critical file
    await fs.writeFile(path.join(workspace, "critical.txt"), "CRITICAL LIVE DATA", "utf8");
    await fs.writeFile(path.join(isolated, "critical.txt"), "MUTATED DATA", "utf8");
    await fs.writeFile(path.join(isolated, "trigger_fail.txt"), "FAIL DATA", "utf8");

    const baseline = await takeWorkspaceSnapshot(workspace);

    const cs: WorkerChangeset = {
      jobId: "worker-fail",
      isolatedWorkspace: isolated,
      modifiedFiles: ["critical.txt"],
      addedFiles: ["trigger_fail.txt"],
      deletedFiles: [],
      fileSnapshots: new Map([
        ["critical.txt", await hashFile(path.join(isolated, "critical.txt"))],
        ["trigger_fail.txt", await hashFile(path.join(isolated, "trigger_fail.txt"))]
      ])
    };

    let backupDirObserved = "";
    const originalCopyFile = fs.copyFile;
    const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dst, flags) => {
      const srcStr = String(src);
      const dstStr = String(dst);

      // Track backup location
      if (dstStr.includes("omega-bridge-backup")) {
        const match = dstStr.match(/.*omega-bridge-backup-[^\\\/]+/);
        if (match && match[0]) backupDirObserved = match[0];
      }

      // Phase 2 apply failure on trigger_fail.txt
      if (dstStr.includes("trigger_fail.txt")) {
        throw new Error("EIO: disk write error on trigger_fail.txt");
      }

      // Phase 3 rollback failure: fail restoring critical.txt from backup
      if (srcStr.includes("omega-bridge-backup") && dstStr.includes("critical.txt")) {
        throw new Error("EPERM: cannot restore critical.txt during rollback");
      }

      return originalCopyFile(src, dst, flags);
    });

    try {
      await expect(applyIntegration(workspace, [cs], baseline)).rejects.toThrow(
        /rollback failed.*Backups preserved at/i
      );

      expect(backupDirObserved).toBeTruthy();
      // Verify backup directory STILL EXISTS and was NOT deleted!
      const backupDirExists = await fs.access(backupDirObserved).then(() => true).catch(() => false);
      expect(backupDirExists).toBe(true);

      // Verify the backup file itself is still preserved on disk!
      const backedUpContent = await fs.readFile(path.join(backupDirObserved, "critical.txt"), "utf8");
      expect(backedUpContent).toBe("CRITICAL LIVE DATA");
    } finally {
      copySpy.mockRestore();
      if (backupDirObserved) {
        await fs.rm(backupDirObserved, { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it("never deletes preexisting identical files from live workspace on rollback", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const isolated = path.join(root, "iso-worker");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(isolated, { recursive: true });

    // Existing live file with identical content
    await fs.writeFile(path.join(workspace, "preexisting.txt"), "PREEXISTING USER DATA", "utf8");
    await fs.writeFile(path.join(isolated, "preexisting.txt"), "PREEXISTING USER DATA", "utf8");

    // Another file that will fail during apply
    await fs.writeFile(path.join(isolated, "fail.txt"), "FAIL DATA", "utf8");

    const preexistingSnap = await hashFile(path.join(workspace, "preexisting.txt"));
    const failSnap = await hashFile(path.join(isolated, "fail.txt"));

    const cs: WorkerChangeset = {
      jobId: "worker-preexisting",
      isolatedWorkspace: isolated,
      modifiedFiles: [],
      addedFiles: ["preexisting.txt", "fail.txt"],
      deletedFiles: [],
      fileSnapshots: new Map([
        ["preexisting.txt", preexistingSnap],
        ["fail.txt", failSnap]
      ])
    };

    // Inject fault when copying fail.txt
    const originalCopyFile = fs.copyFile;
    const copySpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dst, flags) => {
      if (String(dst).includes("fail.txt")) {
        throw new Error("Simulated failure applying fail.txt");
      }
      return originalCopyFile(src, dst, flags);
    });

    try {
      await expect(applyIntegration(workspace, [cs])).rejects.toThrow("Simulated failure applying fail.txt");

      // Verify preexisting.txt was NOT deleted during rollback!
      expect(await fs.readFile(path.join(workspace, "preexisting.txt"), "utf8")).toBe("PREEXISTING USER DATA");
    } finally {
      copySpy.mockRestore();
    }
  });

  it("protects secrets and dependency files from being modified or integrated", async () => {
    const root = await createTempDir();
    const workspace = path.join(root, "workspace");
    const isolated = path.join(root, "iso-worker");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(isolated, { recursive: true });

    await fs.writeFile(path.join(workspace, ".env"), "SECRET=val", "utf8");
    await fs.writeFile(path.join(workspace, "package.json"), '{"name": "app"}', "utf8");

    // Worker attempts to touch package.json and .env
    await fs.writeFile(path.join(isolated, "package.json"), '{"name": "mutated"}', "utf8");
    await fs.writeFile(path.join(isolated, ".env"), "SECRET=hacked", "utf8");

    const baseline = await takeWorkspaceSnapshot(workspace);
    const cs = await detectWorkerChanges(baseline, isolated);

    // .env must never be in worker changeset
    expect(cs.modifiedFiles.includes(".env")).toBe(false);
    expect(cs.deletedFiles.includes(".env")).toBe(false);

    // package.json modification must be blocked by conflict detection
    const liveSnapshot = await takeWorkspaceSnapshot(workspace);
    const report = detectIntegrationConflicts(baseline, liveSnapshot, [cs]);
    expect(report.hasConflict).toBe(true);
    expect(report.conflicts.some((c) => c.includes("Dependency mutation blocked"))).toBe(true);

    // Even if maliciously inserted into a changeset, applyIntegration must reject it
    const maliciousCs: WorkerChangeset = {
      jobId: "malicious",
      isolatedWorkspace: isolated,
      modifiedFiles: [".env"],
      addedFiles: [],
      deletedFiles: [],
      fileSnapshots: new Map()
    };

    await expect(applyIntegration(workspace, [maliciousCs])).rejects.toThrow(/Security violation.*protected/i);
    // Live .env must remain untouched
    expect(await fs.readFile(path.join(workspace, ".env"), "utf8")).toBe("SECRET=val");
  });

  it("builds truthful peer review prompt representing fresh independent invocation with read-only access", () => {
    const dummyRun = {
      spec: {
        goal: "Test run goal",
        constraints: ["Must not regress"],
        success_criteria: ["Clean test pass"]
      }
    } as unknown as BridgeRun;

    const dummyJob = {
      id: "execution-002",
      title: "Worker Feature A",
      objective: "Implement feature A",
      successCriteria: ["Feature A implemented"],
      resultSummary: "Finished feature A cleanly",
      changedFiles: ["feature_a.ts"],
      checksRun: ["typecheck", "unit test"]
    } as unknown as BridgeJob;

    const prompt = buildPeerReviewPrompt(dummyRun, dummyJob);
    expect(prompt).toContain("fresh, independent reviewer invocation");
    expect(prompt).toContain("Worker Feature A");
    expect(prompt).toContain("strictly read-only access");
    expect(prompt).toContain("not another writer");
    expect(prompt).toContain("no access to shared writable data");
    expect(prompt).not.toContain("on behalf of");
  });
});
