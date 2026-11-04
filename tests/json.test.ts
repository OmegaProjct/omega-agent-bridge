import { describe, expect, it } from "vitest";

import { extractJsonDocument } from "../src/json.js";

describe("extractJsonDocument", () => {
  it("extracts plain JSON", () => {
    expect(extractJsonDocument('{"ok":true}')).toBe('{"ok":true}');
  });

  it("extracts fenced JSON", () => {
    expect(extractJsonDocument("```json\n{\"ok\":true}\n```")).toBe('{"ok":true}');
  });

  it("extracts the first balanced object from mixed text", () => {
    expect(extractJsonDocument('Result:\n{"ok":true,"items":["a","b"]}\nDone.')).toBe('{"ok":true,"items":["a","b"]}');
  });
});
