import { describe, it, expect } from "vitest";
import { filterAndDedup, scoreThresholdFor } from "../src/dedup.js";
import { DEFAULT_PROFILE } from "../src/config.js";
import type { QdrantResult } from "../src/search.js";
import type { AgentProfile } from "../src/config.js";

function makeHit(source: string, sourceType: string, score: number): QdrantResult {
  return {
    id: `${source}-${score}`,
    score,
    payload: {
      source,
      source_type: sourceType,
      agent_id: "*",
      location: "yarychiv",
      tags: [],
      text: `Content from ${source}`,
      indexed_at: "2026-04-13T00:00:00Z",
    },
  };
}

// ---

describe("scoreThresholdFor", () => {
  it("returns type-specific threshold when present", () => {
    const thresholds = { default: 0.5, ha_entity: 0.4 };
    expect(scoreThresholdFor("ha_entity", thresholds)).toBe(0.4);
  });

  it("falls back to default when type not in map", () => {
    const thresholds = { default: 0.5, ha_entity: 0.4 };
    expect(scoreThresholdFor("memory", thresholds)).toBe(0.5);
  });

  it("falls back to 0.5 when default missing", () => {
    const thresholds = {};
    expect(scoreThresholdFor("memory", thresholds)).toBe(0.5);
  });

  it("returns exact default when type matches default key", () => {
    const thresholds = { default: 0.6 };
    expect(scoreThresholdFor("default", thresholds)).toBe(0.6);
  });
});

// ---

describe("filterAndDedup", () => {
  const profile: AgentProfile = {
    ...DEFAULT_PROFILE,
    top_k: 3,
    score_thresholds: { default: 0.5, ha_entity: 0.4 },
  };

  it("returns empty array for empty input", () => {
    expect(filterAndDedup([], profile)).toEqual([]);
  });

  it("filters out hits below score threshold", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.3),   // below 0.5
      makeHit("memory/b.md", "memory", 0.7),   // above 0.5
    ];
    const result = filterAndDedup(hits, profile);
    expect(result).toHaveLength(1);
    expect(result[0].payload.source).toBe("memory/b.md");
  });

  it("uses per-type threshold: ha_entity at 0.4 passes 0.45", () => {
    const hits = [
      makeHit("ha_entity:climate.x", "ha_entity", 0.45),  // 0.45 >= 0.4 → pass
      makeHit("memory/a.md", "memory", 0.45),             // 0.45 < 0.5 → filtered
    ];
    const result = filterAndDedup(hits, profile);
    expect(result).toHaveLength(1);
    expect(result[0].payload.source).toBe("ha_entity:climate.x");
  });

  it("keeps highest-scoring chunk per source, discards duplicates", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.6),
      makeHit("memory/a.md", "memory", 0.8),  // same source, higher score
      makeHit("memory/a.md", "memory", 0.55),
    ];
    const result = filterAndDedup(hits, profile);
    expect(result).toHaveLength(1);
    expect(result[0].score).toBe(0.8);
  });

  it("returns results sorted by score descending", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.6),
      makeHit("memory/b.md", "memory", 0.9),
      makeHit("memory/c.md", "memory", 0.75),
    ];
    const result = filterAndDedup(hits, profile);
    expect(result[0].score).toBe(0.9);
    expect(result[1].score).toBe(0.75);
    expect(result[2].score).toBe(0.6);
  });

  it("respects top_k limit", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.9),
      makeHit("memory/b.md", "memory", 0.85),
      makeHit("memory/c.md", "memory", 0.8),
      makeHit("memory/d.md", "memory", 0.75),  // top_k=3 → dropped
    ];
    const result = filterAndDedup(hits, profile);
    expect(result).toHaveLength(3);
    expect(result.map((h) => h.payload.source)).not.toContain("memory/d.md");
  });

  it("dedup and top_k compose correctly: dedup first, then top_k", () => {
    // 4 unique sources but top_k=3 — should keep top 3 after dedup
    const hits = [
      makeHit("memory/a.md", "memory", 0.9),
      makeHit("memory/a.md", "memory", 0.6),  // dupe of a, lower
      makeHit("memory/b.md", "memory", 0.85),
      makeHit("memory/c.md", "memory", 0.8),
      makeHit("memory/d.md", "memory", 0.75),
    ];
    const result = filterAndDedup(hits, profile);
    expect(result).toHaveLength(3);
    expect(result[0].score).toBe(0.9);
    expect(result[0].payload.source).toBe("memory/a.md");
  });

  it("all hits below threshold → empty result", () => {
    const hits = [
      makeHit("memory/a.md", "memory", 0.3),
      makeHit("memory/b.md", "memory", 0.2),
    ];
    expect(filterAndDedup(hits, profile)).toEqual([]);
  });
});
