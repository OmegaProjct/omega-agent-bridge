import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const source = path.join(root, "skills", "omega-agent-bridge");
const controllers = ["codex", "claude", "antigravity"];

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(source))) {
  throw new Error(`Skill source not found: ${source}`);
}

for (const controller of controllers) {
  const target = path.join(root, "skills", controller, "omega-agent-bridge");
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true });
  process.stdout.write(`generated ${path.relative(root, target)}\n`);
}
