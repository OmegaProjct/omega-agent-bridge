import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readAgyTranscriptOutput } from "../src/agents/agy.js";

const tempRoots: string[] = [];

async function createFakeCliHome(): Promise<{ root: string; workspace: string; }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-transcript-"));
  tempRoots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  return { root, workspace };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (target) => {
    await fs.rm(target, { recursive: true, force: true });
  }));
});

describe("readAgyTranscriptOutput", () => {
  it("returns the last model JSON content from the transcript", async () => {
    const { root, workspace } = await createFakeCliHome();
    const cliRoot = path.join(root, ".gemini", "antigravity-cli");
    const conversationId = "conversation-1";
    const cachePath = path.join(cliRoot, "cache");
    const transcriptDir = path.join(cliRoot, "brain", conversationId, ".system_generated", "logs");
    await fs.mkdir(cachePath, { recursive: true });
    await fs.mkdir(transcriptDir, { recursive: true });

    await fs.writeFile(
      path.join(cachePath, "last_conversations.json"),
      `${JSON.stringify({ [path.resolve(workspace)]: conversationId }, null, 2)}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(transcriptDir, "transcript.jsonl"),
      [
        JSON.stringify({ source: "MODEL", type: "LIST_DIRECTORY", content: "tool output" }),
        JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: "{\"summary\":\"ok\"}" })
      ].join("\n"),
      "utf8"
    );

    await expect(readAgyTranscriptOutput(workspace, root)).resolves.toBe("{\"summary\":\"ok\"}");
  });
});
