export function extractJsonDocument(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Agent output was empty.");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const startIndexes = [trimmed.indexOf("{"), trimmed.indexOf("[")]
    .filter((value) => value >= 0)
    .sort((left, right) => left - right);

  for (const start of startIndexes) {
    const extracted = tryExtractBalancedJson(trimmed, start);
    if (extracted) {
      return extracted;
    }
  }

  throw new Error("Could not find a JSON object or array in agent output.");
}

function tryExtractBalancedJson(input: string, startIndex: number): string | null {
  const opening = input[startIndex];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < input.length; index += 1) {
    const char = input[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === opening) {
      depth += 1;
      continue;
    }

    if (char === closing) {
      depth -= 1;
      if (depth === 0) {
        return input.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}
