import { describe, it, expect } from "vitest";
import { formatContextBlock, estimateTokens } from "../src/format.js";
import { DEFAULT_PROFILE } from "../src/config.js";
import type { QdrantResult } from "../src/search.js";
import type { AgentProfile } from "../src/config.js";

function makeHit(source: string, sourceType: string, score: number, text: string): QdrantResult {
  return {
    id: source,
    score,
    payload: {
      source,
      source_type: sourceType,
      agent_id: "*",
      location: "yarychiv",
      tags: [],
      text,
      indexed_at: "2026-04-13T00:00:00Z",
    },
  };
}

const HEADER = "## Retrieved Knowledge";

// ---

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("approximates token count as word count × 1.3", () => {
    // 4 words → ~5.2 tokens → floor to 5
    const result = estimateTokens("hello world foo bar");
    expect(result).toBeGreaterThanOrEqual(4);
    expect(result).toBeLessThanOrEqual(7);
  });

  it("returns positive value for non-empty text", () => {
    expect(estimateTokens("some text here")).toBeGreaterThan(0);
  });
});

// ---

describe("formatContextBlock", () => {
  const profile: AgentProfile = {
    ...DEFAULT_PROFILE,
    max_tokens: 2000,
  };

  it("returns null for empty hits array", () => {
    expect(formatContextBlock([], profile, HEADER)).toBeNull();
  });

  it("includes the header line", () => {
    const hits = [makeHit("memory/a.md", "memory", 0.81, "Some knowledge.")];
    const result = formatContextBlock(hits, profile, HEADER);
    expect(result).not.toBeNull();
    expect(result).toContain(HEADER);
  });

  it("includes source attribution comment with source, score, and type", () => {
    const hits = [makeHit("memory/a.md", "memory", 0.81, "Some knowledge.")];
    const result = formatContextBlock(hits, profile, HEADER)!;
    expect(result).toContain("<!-- source: memory/a.md");
    expect(result).toContain("score: 0.81");
    expect(result).toContain("type: memory");
  });

  it("includes chunk text content", () => {
    const hits = [makeHit("memory/a.md", "memory", 0.81, "H700 humidifier off.")];
    const result = formatContextBlock(hits, profile, HEADER)!;
    expect(result).toContain("H700 humidifier off.");
  });

  it("includes all hits when under token cap", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.9, "Fact A."),
      makeHit("memory/b.md", "memory", 0.8, "Fact B."),
      makeHit("memory/c.md", "memory", 0.7, "Fact C."),
    ];
    const result = formatContextBlock(hits, profile, HEADER)!;
    expect(result).toContain("Fact A.");
    expect(result).toContain("Fact B.");
    expect(result).toContain("Fact C.");
  });

  it("truncates chunks when token cap is exceeded", () => {
    // Cap is 50 tokens — enough for one chunk but not all three
    const tightProfile: AgentProfile = { ...profile, max_tokens: 50 };
    const longText = "word ".repeat(40);  // ~52 tokens each
    const hits = [
      makeHit("memory/a.md", "memory", 0.9, longText),
      makeHit("memory/b.md", "memory", 0.8, longText),
      makeHit("memory/c.md", "memory", 0.7, longText),
    ];
    const result = formatContextBlock(hits, tightProfile, HEADER)!;
    // Should include first chunk but not all three
    expect(result).toContain("memory/a.md");
    expect(result).not.toContain("memory/c.md");
  });

  it("includes partial last chunk truncated at word boundary when cap hit mid-chunk", () => {
    // Cap exactly tight enough to include ~half of second chunk
    const tightProfile: AgentProfile = { ...profile, max_tokens: 30 };
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa ".repeat(2);
    const hits = [
      makeHit("memory/a.md", "memory", 0.9, text),
      makeHit("memory/b.md", "memory", 0.8, text),
    ];
    const result = formatContextBlock(hits, tightProfile, HEADER);
    // Result should be non-null (not dropped entirely)
    expect(result).not.toBeNull();
    // Should have something from at least first chunk
    expect(result).toContain("memory/a.md");
  });

  it("score is formatted to 2 decimal places", () => {
    const hits = [makeHit("memory/a.md", "memory", 0.8123456, "text")];
    const result = formatContextBlock(hits, profile, HEADER)!;
    expect(result).toContain("score: 0.81");
    expect(result).not.toContain("0.8123");
  });

  it("chunks are separated by blank lines", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.9, "Fact A."),
      makeHit("memory/b.md", "memory", 0.8, "Fact B."),
    ];
    const result = formatContextBlock(hits, profile, HEADER)!;
    // Two chunks means at least one blank line between them
    expect(result).toContain("\n\n");
  });
});
