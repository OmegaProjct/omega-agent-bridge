import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

/**
 * Workspace isolation, snapshotting, and conflict detection utilities.
 *
 * CRITICAL SECURITY & ARCHITECTURAL LIMITATION NOTICE:
 * Directory copies do NOT provide an OS-level security boundary or sandbox.
 * Because agent processes run with `--dangerously-skip-permissions`, child agents
 * retain unrestricted host filesystem access. Parallel agents running in directory
 * copies can access secrets, read or modify live user files outside their working directory,
 * or interfere with each other regardless of cwd.
 *
 * Furthermore, automatic integration (`applyIntegration`) suffers from an unavoidable
 * TOCTOU (Time of Check to Time of Use) race between drift/hash verification and file
 * copying/unlinking, which can overwrite concurrent live user edits.
 *
 * Because robust OS-level sandbox isolation per writer (such as Windows AppContainers or
 * hypervisor sandboxes) is not reliably available or testable on Windows in this environment,
 * parallel writer dispatch and auto-integration are unsupported and disabled in the orchestrator.
 * All write-capable jobs run strictly sequentially with exclusive workspace access.
 *
 * These utility functions are preserved for snapshotting, change detection, and potential
 * future sandboxed execution backends. Directory copies must NEVER be treated as a security boundary.
 */

export interface FileSnapshot {
  hash: string;
  size: number;
}

export interface WorkerChangeset {
  jobId: string;
  isolatedWorkspace: string;
  modifiedFiles: string[];
  addedFiles: string[];
  deletedFiles: string[];
  fileSnapshots: Map<string, FileSnapshot>;
}

export interface ConflictReport {
  hasConflict: boolean;
  conflicts: string[];
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function isProtectedPath(relPath: string): boolean {
  const normalized = normalizePath(relPath).replace(/^\/+/, "");
  const base = path.posix.basename(normalized);
  const lowerBase = base.toLowerCase();

  // Git internals
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    return true;
  }
  // Node modules
  if (normalized === "node_modules" || normalized.startsWith("node_modules/")) {
    return true;
  }
  // Omega bridge internal state
  if (normalized === ".omega-agent-bridge" || normalized.startsWith(".omega-agent-bridge/")) {
    return true;
  }

  // Environment and credential files
  if (lowerBase === ".env" || lowerBase.startsWith(".env.")) {
    return true;
  }
  if (lowerBase === ".npmrc" || lowerBase === ".pypirc") {
    return true;
  }
  if (lowerBase.includes("secret") || lowerBase.includes("credential")) {
    return true;
  }
  if (
    lowerBase.startsWith("id_rsa") ||
    lowerBase.startsWith("id_ed25519") ||
    lowerBase.startsWith("id_ecdsa") ||
    lowerBase.startsWith("id_dsa")
  ) {
    return true;
  }
  if (
    lowerBase.endsWith(".pem") ||
    lowerBase.endsWith(".key") ||
    lowerBase.endsWith(".p12") ||
    lowerBase.endsWith(".pfx")
  ) {
    return true;
  }
  if (normalized.startsWith(".ssh/") || normalized.startsWith(".aws/")) {
    return true;
  }

  return false;
}

export function isDependencyFile(relPath: string): boolean {
  const normalized = normalizePath(relPath).replace(/^\/+/, "");
  const base = path.posix.basename(normalized);
  if (normalized === "node_modules" || normalized.startsWith("node_modules/")) {
    return true;
  }
  return (
    base === "package.json" ||
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base === "npm-shrinkwrap.json"
  );
}

export function shouldIgnorePath(relPath: string, ignorePatterns: string[] = []): boolean {
  const normalized = normalizePath(relPath).replace(/^\/+/, "");
  if (isProtectedPath(normalized)) {
    return true;
  }
  for (const pattern of ignorePatterns) {
    const normPattern = normalizePath(pattern).replace(/^\/+/, "");
    if (normalized === normPattern || normalized.startsWith(normPattern + "/")) {
      return true;
    }
  }
  return false;
}

export async function hashFile(filePath: string): Promise<FileSnapshot> {
  const buffer = await fs.readFile(filePath);
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return {
    hash,
    size: buffer.length
  };
}

export async function takeWorkspaceSnapshot(
  workspaceDir: string,
  ignorePatterns: string[] = []
): Promise<Map<string, FileSnapshot>> {
  const snapshot = new Map<string, FileSnapshot>();

  async function walk(currentDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = normalizePath(path.relative(workspaceDir, fullPath));

      if (shouldIgnorePath(relPath, ignorePatterns)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        throw new Error(
          `Security violation: Symlink detected at '${relPath}'. Symlinks are not permitted in workspace snapshots.`
        );
      }

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const snap = await hashFile(fullPath);
        snapshot.set(relPath, snap);
      }
    }
  }

  await walk(workspaceDir);
  return snapshot;
}

export async function createIsolatedWorkspace(
  liveWorkspace: string,
  targetDir: string,
  ignorePatterns: string[] = []
): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });

  async function copyEntries(srcDir: string, dstDir: string): Promise<void> {
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry.name);
      const dstPath = path.join(dstDir, entry.name);
      const relPath = normalizePath(path.relative(liveWorkspace, srcPath));

      if (shouldIgnorePath(relPath, ignorePatterns)) {
        continue;
      }

      if (entry.isSymbolicLink()) {
        throw new Error(
          `Security violation: Symlink detected at '${relPath}'. Symlinks are not permitted in isolated workspaces.`
        );
      }

      if (entry.isDirectory()) {
        await fs.mkdir(dstPath, { recursive: true });
        await copyEntries(srcPath, dstPath);
      } else if (entry.isFile()) {
        await fs.copyFile(srcPath, dstPath);
      }
    }
  }

  await copyEntries(liveWorkspace, targetDir);
}

export async function detectWorkerChanges(
  baselineSnapshot: Map<string, FileSnapshot>,
  isolatedWorkspace: string,
  ignorePatterns: string[] = []
): Promise<WorkerChangeset> {
  const currentSnapshot = await takeWorkspaceSnapshot(isolatedWorkspace, ignorePatterns);
  const modifiedFiles: string[] = [];
  const addedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [relPath, currentSnap] of currentSnapshot.entries()) {
    if (isProtectedPath(relPath)) {
      continue;
    }
    const baseSnap = baselineSnapshot.get(relPath);
    if (!baseSnap) {
      addedFiles.push(relPath);
    } else if (baseSnap.hash !== currentSnap.hash) {
      modifiedFiles.push(relPath);
    }
  }

  for (const relPath of baselineSnapshot.keys()) {
    if (isProtectedPath(relPath)) {
      continue;
    }
    if (!currentSnapshot.has(relPath)) {
      deletedFiles.push(relPath);
    }
  }

  return {
    jobId: path.basename(isolatedWorkspace),
    isolatedWorkspace,
    modifiedFiles: modifiedFiles.sort(),
    addedFiles: addedFiles.sort(),
    deletedFiles: deletedFiles.sort(),
    fileSnapshots: currentSnapshot
  };
}

export function detectIntegrationConflicts(
  baselineSnapshot: Map<string, FileSnapshot>,
  liveSnapshot: Map<string, FileSnapshot>,
  changesets: WorkerChangeset[]
): ConflictReport {
  const conflicts: string[] = [];

  // Check for protected file violations and dependency mutations
  for (const cs of changesets) {
    const allTouched = [...cs.modifiedFiles, ...cs.addedFiles, ...cs.deletedFiles];
    for (const f of allTouched) {
      if (isProtectedPath(f)) {
        conflicts.push(
          `Protected path violation: Worker '${cs.jobId}' touched protected path or secret '${f}'. Secrets and git internals cannot be modified.`
        );
      }
      if (isDependencyFile(f)) {
        conflicts.push(
          `Dependency mutation blocked: Worker '${cs.jobId}' touched dependency file '${f}'. Modifying dependencies or node_modules is unsupported across concurrent writers to prevent live dependency corruption.`
        );
      }
    }
  }

  // 1. Intra-worker conflict detection (conflicts between peer writers)
  for (let i = 0; i < changesets.length; i++) {
    const a = changesets[i]!;
    for (let j = i + 1; j < changesets.length; j++) {
      const b = changesets[j]!;

      // Modified by both with differing hashes
      for (const f of a.modifiedFiles) {
        if (b.modifiedFiles.includes(f)) {
          const hashA = a.fileSnapshots.get(f)?.hash;
          const hashB = b.fileSnapshots.get(f)?.hash;
          if (hashA !== hashB) {
            conflicts.push(
              `Intra-worker conflict: Workers '${a.jobId}' and '${b.jobId}' both modified '${f}' with conflicting contents.`
            );
          }
        }
        if (b.deletedFiles.includes(f)) {
          conflicts.push(
            `Intra-worker conflict: Worker '${a.jobId}' modified '${f}' while Worker '${b.jobId}' deleted it.`
          );
        }
      }

      // Added by both with differing hashes
      for (const f of a.addedFiles) {
        if (b.addedFiles.includes(f)) {
          const hashA = a.fileSnapshots.get(f)?.hash;
          const hashB = b.fileSnapshots.get(f)?.hash;
          if (hashA !== hashB) {
            conflicts.push(
              `Intra-worker conflict: Workers '${a.jobId}' and '${b.jobId}' both created '${f}' with conflicting contents.`
            );
          }
        }
      }

      // Deleted by A, modified by B
      for (const f of a.deletedFiles) {
        if (b.modifiedFiles.includes(f)) {
          conflicts.push(
            `Intra-worker conflict: Worker '${a.jobId}' deleted '${f}' while Worker '${b.jobId}' modified it.`
          );
        }
      }
    }
  }

  // 2. Live workspace drift and untracked/uncommitted preservation
  for (const cs of changesets) {
    // Check modified files
    for (const f of cs.modifiedFiles) {
      const currentLive = liveSnapshot.get(f);
      const baseline = baselineSnapshot.get(f);
      if (!currentLive) {
        conflicts.push(
          `Live workspace conflict: File '${f}' modified by worker '${cs.jobId}' was deleted in live workspace.`
        );
      } else if (baseline && currentLive.hash !== baseline.hash) {
        conflicts.push(
          `Live workspace conflict: File '${f}' was modified in live workspace during execution (uncommitted/external change detected).`
        );
      }
    }

    // Check added files against untracked/uncommitted files in live workspace
    for (const f of cs.addedFiles) {
      if (liveSnapshot.has(f)) {
        const liveFile = liveSnapshot.get(f);
        const workerFile = cs.fileSnapshots.get(f);
        if (liveFile && workerFile && liveFile.hash !== workerFile.hash) {
          conflicts.push(
            `Live workspace conflict: File '${f}' already exists in live workspace (untracked user file or external addition) and would be overwritten by worker '${cs.jobId}'.`
          );
        }
      }
    }

    // Check deleted files
    for (const f of cs.deletedFiles) {
      const currentLive = liveSnapshot.get(f);
      const baseline = baselineSnapshot.get(f);
      if (currentLive && baseline && currentLive.hash !== baseline.hash) {
        conflicts.push(
          `Live workspace conflict: File '${f}' was modified in live workspace, cannot safely delete.`
        );
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts
  };
}

/**
 * Applies worker changes to a target workspace with backup and rollback protection.
 *
 * LIMITATION & CONCURRENCY WARNING:
 * This function has an inherent TOCTOU (Time of Check to Time of Use) race condition:
 * external file changes occurring between hash verification, backup creation, and
 * copyFile/rm cannot be detected atomically on Windows without transactional filesystem
 * primitives. Automatic integration of parallel writer batches is unsupported and
 * disabled in the orchestrator.
 */
export async function applyIntegration(
  liveWorkspace: string,
  changesets: WorkerChangeset[],
  baselineSnapshot?: Map<string, FileSnapshot>
): Promise<void> {
  const tempBackupDir = path.join(
    os.tmpdir(),
    `omega-bridge-backup-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
  );
  await fs.mkdir(tempBackupDir, { recursive: true });

  const backedUpFiles: string[] = [];
  const newlyCreatedFiles: string[] = [];
  const verifiedExistingFiles = new Set<string>();

  // Helper to validate path safety against symlink/junction escape and traversal
  async function validatePathSafety(relPath: string, isolatedWorkspace: string, isDeleted: boolean): Promise<void> {
    const norm = normalizePath(relPath);
    if (
      !norm ||
      norm === "." ||
      norm === ".." ||
      norm.startsWith("../") ||
      norm.includes("/../") ||
      path.isAbsolute(relPath)
    ) {
      throw new Error(`Security violation: Path traversal detected in '${relPath}'.`);
    }

    if (isProtectedPath(norm)) {
      throw new Error(`Security violation: Modification of protected path or secret '${relPath}' is forbidden.`);
    }

    if (isDependencyFile(norm)) {
      throw new Error(
        `Security violation: Modification of dependency file '${relPath}' is unsupported across concurrent writers.`
      );
    }

    // Validate live workspace destination
    const resolvedLive = path.resolve(liveWorkspace, norm);
    const relFromLive = path.relative(liveWorkspace, resolvedLive);
    if (relFromLive.startsWith("..") || path.isAbsolute(relFromLive)) {
      throw new Error(`Security violation: Path '${relPath}' escapes live workspace.`);
    }

    // Check for symlinks/junctions in live workspace hierarchy
    let currentLiveDir = path.dirname(resolvedLive);
    while (currentLiveDir.startsWith(liveWorkspace)) {
      const stat = await fs.lstat(currentLiveDir).catch(() => null);
      if (stat && stat.isSymbolicLink()) {
        throw new Error(
          `Security violation: Symlink or junction traversal detected in live directory '${currentLiveDir}'.`
        );
      }
      if (currentLiveDir === liveWorkspace) break;
      const parent = path.dirname(currentLiveDir);
      if (parent === currentLiveDir) break;
      currentLiveDir = parent;
    }

    const liveStat = await fs.lstat(resolvedLive).catch(() => null);
    if (liveStat && liveStat.isSymbolicLink()) {
      throw new Error(`Security violation: Live path '${relPath}' is a symlink or junction.`);
    }

    // For added or modified files, validate source in isolated workspace
    if (!isDeleted) {
      const resolvedSrc = path.resolve(isolatedWorkspace, norm);
      const relFromSrc = path.relative(isolatedWorkspace, resolvedSrc);
      if (relFromSrc.startsWith("..") || path.isAbsolute(relFromSrc)) {
        throw new Error(`Security violation: Source path '${relPath}' escapes isolated workspace.`);
      }

      let currentSrcDir = path.dirname(resolvedSrc);
      while (currentSrcDir.startsWith(isolatedWorkspace)) {
        const stat = await fs.lstat(currentSrcDir).catch(() => null);
        if (stat && stat.isSymbolicLink()) {
          throw new Error(
            `Security violation: Symlink or junction detected in isolated directory '${currentSrcDir}'.`
          );
        }
        if (currentSrcDir === isolatedWorkspace) break;
        const parent = path.dirname(currentSrcDir);
        if (parent === currentSrcDir) break;
        currentSrcDir = parent;
      }

      const srcStat = await fs.lstat(resolvedSrc);
      if (srcStat.isSymbolicLink()) {
        throw new Error(`Security violation: Newly created symlink detected at '${relPath}'. Symlinks are not permitted.`);
      }
    }
  }

  // Pre-validation and drift verification
  for (const cs of changesets) {
    for (const f of cs.modifiedFiles) {
      await validatePathSafety(f, cs.isolatedWorkspace, false);
      const liveFilePath = path.join(liveWorkspace, f);
      const exists = await fs.lstat(liveFilePath).then(() => true).catch(() => false);
      if (!exists) {
        throw new Error(`Live workspace drift detected: Modified file '${f}' does not exist in live workspace.`);
      }
      if (baselineSnapshot) {
        const expectedBase = baselineSnapshot.get(f);
        const currentHash = (await hashFile(liveFilePath)).hash;
        if (expectedBase && currentHash !== expectedBase.hash) {
          throw new Error(`Live workspace drift detected: File '${f}' was modified concurrently in live workspace.`);
        }
      }
    }

    for (const f of cs.deletedFiles) {
      await validatePathSafety(f, cs.isolatedWorkspace, true);
      const liveFilePath = path.join(liveWorkspace, f);
      const exists = await fs.lstat(liveFilePath).then(() => true).catch(() => false);
      if (exists && baselineSnapshot) {
        const expectedBase = baselineSnapshot.get(f);
        const currentHash = (await hashFile(liveFilePath)).hash;
        if (expectedBase && currentHash !== expectedBase.hash) {
          throw new Error(`Live workspace drift detected: Deleted file '${f}' was modified concurrently in live workspace.`);
        }
      }
    }

    for (const f of cs.addedFiles) {
      await validatePathSafety(f, cs.isolatedWorkspace, false);
      const liveFilePath = path.join(liveWorkspace, f);
      const exists = await fs.lstat(liveFilePath).then(() => true).catch(() => false);
      if (exists) {
        const srcFilePath = path.join(cs.isolatedWorkspace, f);
        const liveHash = (await hashFile(liveFilePath)).hash;
        const srcHash = (await hashFile(srcFilePath)).hash;
        if (liveHash !== srcHash) {
          throw new Error(
            `Live workspace conflict: File '${f}' already exists in live workspace with conflicting contents.`
          );
        }
        // It exists with identical hash: track it as preexisting identical file
        verifiedExistingFiles.add(f);
      }
    }
  }

  // Phase 1: Backup files that will be modified or deleted
  try {
    for (const cs of changesets) {
      for (const f of [...cs.modifiedFiles, ...cs.deletedFiles]) {
        if (!backedUpFiles.includes(f)) {
          const liveFilePath = path.join(liveWorkspace, f);
          const liveExists = await fs.lstat(liveFilePath).then(() => true).catch(() => false);
          if (liveExists) {
            const backupFilePath = path.join(tempBackupDir, f);
            await fs.mkdir(path.dirname(backupFilePath), { recursive: true });
            await fs.copyFile(liveFilePath, backupFilePath);
            backedUpFiles.push(f);
            verifiedExistingFiles.add(f);
          }
        }
      }
    }
  } catch (backupError) {
    // If backup fails before applying any change, stop and fail closed
    await fs.rm(tempBackupDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Backup failure during pre-integration: ${backupError instanceof Error ? backupError.message : String(backupError)}`
    );
  }

  // Phase 2: Apply changes
  try {
    for (const cs of changesets) {
      // 1. Modified and Added files
      for (const f of [...cs.modifiedFiles, ...cs.addedFiles]) {
        const srcPath = path.join(cs.isolatedWorkspace, f);
        const dstPath = path.join(liveWorkspace, f);

        const alreadyExisted =
          verifiedExistingFiles.has(f) ||
          (await fs.lstat(dstPath).then(() => true).catch(() => false));
        if (alreadyExisted) {
          verifiedExistingFiles.add(f);
        }

        await fs.mkdir(path.dirname(dstPath), { recursive: true });
        await fs.copyFile(srcPath, dstPath);

        if (!alreadyExisted && !newlyCreatedFiles.includes(f)) {
          newlyCreatedFiles.push(f);
        }
      }

      // 2. Deleted files
      for (const f of cs.deletedFiles) {
        const dstPath = path.join(liveWorkspace, f);
        const exists = await fs.lstat(dstPath).then(() => true).catch(() => false);
        if (exists) {
          await fs.rm(dstPath, { force: false });
        }
      }
    }
  } catch (applyError) {
    // Phase 3: Rollback on apply error
    const rollbackErrors: string[] = [];

    // 1. Remove ONLY newly created files that did NOT exist before integration
    for (const f of newlyCreatedFiles) {
      // Safety check: NEVER delete a file that was verified to exist beforehand!
      if (verifiedExistingFiles.has(f)) {
        continue;
      }
      const dstPath = path.join(liveWorkspace, f);
      try {
        await fs.rm(dstPath, { force: true });
      } catch (rmErr) {
        rollbackErrors.push(
          `Failed to remove newly created file '${f}': ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`
        );
      }
    }

    // 2. Restore backed up files
    for (const f of backedUpFiles) {
      const backupFilePath = path.join(tempBackupDir, f);
      const dstPath = path.join(liveWorkspace, f);
      try {
        await fs.mkdir(path.dirname(dstPath), { recursive: true });
        await fs.copyFile(backupFilePath, dstPath);
      } catch (restoreErr) {
        rollbackErrors.push(
          `Failed to restore '${f}' from backup: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`
        );
      }
    }

    if (rollbackErrors.length > 0) {
      // RETAIN BACKUPS IF ROLLBACK FAILS! DO NOT DELETE tempBackupDir!
      const msg = `Integration failed (${applyError instanceof Error ? applyError.message : String(applyError)}) AND rollback failed (${rollbackErrors.join("; ")}). Backups preserved at: ${tempBackupDir}`;
      throw new Error(msg);
    }

    // If rollback succeeded cleanly, clean up temporary backup directory
    await fs.rm(tempBackupDir, { recursive: true, force: true }).catch(() => {});
    throw applyError;
  }

  // Phase 4: Integration succeeded cleanly, clean up temporary backup directory
  await fs.rm(tempBackupDir, { recursive: true, force: true }).catch(() => {});
}

export async function cleanupIsolatedWorkspace(workspaceDir: string): Promise<void> {
  try {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  } catch {
    // Cleanup errors should not crash the orchestrator
  }
}
