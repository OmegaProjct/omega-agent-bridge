import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();

async function removeIfExists(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function cleanTestArtifacts(targetDir) {
  let entries = [];
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await cleanTestArtifacts(fullPath);
      return;
    }

    if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) {
      await fs.rm(fullPath, { force: true });
    }
  }));
}

await removeIfExists(path.join(root, "dist"));
await cleanTestArtifacts(path.join(root, "tests"));
