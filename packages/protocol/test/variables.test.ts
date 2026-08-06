import { describe, it, expect } from "vitest";
import { interpolateText, Variable } from "../src/variables";

function variable(key: string, value: string, type: Variable["type"] = "text"): Variable {
  return { key, value, type, createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("interpolateText", () => {
  it("replaces a single {key} with its variable's value", () => {
    const vars = { kills: variable("kills", "4", "number") };
    expect(interpolateText("Kills: {kills}", vars)).toBe("Kills: 4");
  });

  it("replaces multiple distinct occurrences", () => {
    const vars = { a: variable("a", "1"), b: variable("b", "2") };
    expect(interpolateText("{a} and {b} and {a} again", vars)).toBe("1 and 2 and 1 again");
  });

  it("leaves an unmatched {key} as a literal, rather than blanking it out", () => {
    expect(interpolateText("Score: {missing}", {})).toBe("Score: {missing}");
  });

  it("leaves text with no braces untouched", () => {
    expect(interpolateText("plain text", {})).toBe("plain text");
  });

  it("does not touch a lone unmatched brace", () => {
    expect(interpolateText("{unclosed and {kills}", { kills: variable("kills", "4") })).toBe(
      "{unclosed and 4"
    );
  });

  it("handles an empty string", () => {
    expect(interpolateText("", {})).toBe("");
  });
});
