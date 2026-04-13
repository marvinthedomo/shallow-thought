/**
 * Integration tests — require live services:
 *   - Qdrant at http://127.0.0.1:6333 (collection: knowledge)
 *   - Ollama at http://127.0.0.1:11434 (model: bge-m3)
 *
 * Run with: SHALLOW_THOUGHT_INTEGRATION=1 vitest run tests/integration.test.ts
 * Skipped automatically when env var is not set.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { embedText, wordCount } from "../src/embed.js";
import { searchKnowledge } from "../src/search.js";
import { filterAndDedup } from "../src/dedup.js";
import { formatContextBlock } from "../src/format.js";
import { loadProfile, inferLocationFilter } from "../src/scope.js";
import { DEFAULT_PROFILE } from "../src/config.js";
import type { PluginConfig, AgentProfile } from "../src/config.js";

const RUN_INTEGRATION = process.env.SHALLOW_THOUGHT_INTEGRATION === "1";
const itInteg = RUN_INTEGRATION ? it : it.skip;

const CONFIG: PluginConfig = {
  qdrant_url: "http://127.0.0.1:6333",
  collection: "knowledge",
  embedding_url: "http://127.0.0.1:11434",
  embedding_model: "bge-m3",
  embedding_timeout_ms: 5000,
  qdrant_timeout_ms: 3000,
  profile_dir: "/Users/marvin/.openclaw/workspace/config/shallow-thought",
  context_block_header: "## Retrieved Knowledge",
  fail_open: true,
  debug_log: false,
  defaults: {
    top_k: 5,
    max_tokens: 2000,
    min_embed_tokens: 5,
    score_thresholds: { default: 0.45, ha_entity: 0.38 },
    context_inference: true,
  },
};

const MARVIN_PROFILE: AgentProfile = {
  ...DEFAULT_PROFILE,
  top_k: 5,
  agent_ids: ["*", "marvin"],
  score_thresholds: { default: 0.45, ha_entity: 0.38 },
  keyword_map: {
    yarychiv: ["yarychiv", "яричів", "яричеві", "village"],
    pechersk: ["pechersk", "печерськ", "kyiv"],
  },
  context_inference: true,
};

// ---

describe("integration: embed", () => {
  itInteg("bge-m3 returns a 1024-dimensional vector", async () => {
    const vector = await embedText("what is the temperature at yarychiv", CONFIG);
    expect(vector).toHaveLength(1024);
    expect(typeof vector[0]).toBe("number");
    expect(isNaN(vector[0])).toBe(false);
  });

  itInteg("two similar queries return similar vectors (cosine > 0.8)", async () => {
    const v1 = await embedText("yarychiv temperature", CONFIG);
    const v2 = await embedText("what is the temp at yarychiv", CONFIG);
    const dot = v1.reduce((sum, val, i) => sum + val * v2[i], 0);
    const mag1 = Math.sqrt(v1.reduce((s, v) => s + v * v, 0));
    const mag2 = Math.sqrt(v2.reduce((s, v) => s + v * v, 0));
    const cosine = dot / (mag1 * mag2);
    expect(cosine).toBeGreaterThan(0.8);
  });

  itInteg("two unrelated queries return dissimilar vectors (cosine < 0.6)", async () => {
    const v1 = await embedText("yarychiv temperature climate", CONFIG);
    const v2 = await embedText("javascript programming async await", CONFIG);
    const dot = v1.reduce((sum, val, i) => sum + val * v2[i], 0);
    const mag1 = Math.sqrt(v1.reduce((s, v) => s + v * v, 0));
    const mag2 = Math.sqrt(v2.reduce((s, v) => s + v * v, 0));
    const cosine = dot / (mag1 * mag2);
    expect(cosine).toBeLessThan(0.6);
  });
});

// ---

describe("integration: search", () => {
  let queryVector: number[];

  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    queryVector = await embedText("yarychiv humidifier H700", CONFIG);
  });

  itInteg("returns results for a relevant query", async () => {
    const results = await searchKnowledge(
      queryVector,
      "marvin",
      MARVIN_PROFILE,
      [],
      CONFIG
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].payload.text).toBeTruthy();
  });

  itInteg("location filter excludes out-of-scope results", async () => {
    const results = await searchKnowledge(
      queryVector,
      "marvin",
      MARVIN_PROFILE,
      ["yarychiv"],
      CONFIG
    );
    for (const r of results) {
      // Either location is yarychiv or location field is absent/wildcard
      if (r.payload.location) {
        expect(r.payload.location).toBe("yarychiv");
      }
    }
  });

  itInteg("type filter works: memory only", async () => {
    const profile: AgentProfile = {
      ...MARVIN_PROFILE,
      include_types: ["memory"],
    };
    const results = await searchKnowledge(
      queryVector,
      "marvin",
      profile,
      [],
      CONFIG
    );
    for (const r of results) {
      // Current indexer uses "type" field
      expect(r.payload.type ?? r.payload.source_type).toBe("memory");
    }
  });
});

// ---

describe("integration: short message bypass", () => {
  itInteg("3-word message is below min_embed_tokens=5", () => {
    // wordCount is not async — just verify the guard works
    expect(wordCount("yes do it")).toBe(3);
    expect(3 < MARVIN_PROFILE.min_embed_tokens).toBe(true);
  });
});

// ---

describe("integration: fail_open on bad Qdrant URL", () => {
  itInteg("searchKnowledge throws SearchError when Qdrant unreachable", async () => {
    const badConfig: PluginConfig = { ...CONFIG, qdrant_url: "http://127.0.0.1:19999" };
    const vector = await embedText("test query", CONFIG);
    const { SearchError } = await import("../src/search.js");
    await expect(
      searchKnowledge(vector, "marvin", MARVIN_PROFILE, [], badConfig)
    ).rejects.toThrow(SearchError);
  });
});

// ---

describe("integration: full pipeline", () => {
  itInteg("before_prompt_build equivalent returns non-empty context for yarychiv query", async () => {
    const message = "What is the current status of the H700 humidifier at Yarychiv?";

    // Step 1: embed
    const vector = await embedText(message, CONFIG);
    expect(vector).toHaveLength(1024);

    // Step 2: infer location filter
    const locationFilter = inferLocationFilter(message, MARVIN_PROFILE);
    expect(locationFilter).toContain("yarychiv");

    // Step 3: search
    // NOTE: current index has no "location" field — pass empty filter so all docs are eligible.
    // Once the indexer is updated to include location, use locationFilter directly.
    const raw = await searchKnowledge(vector, "marvin", MARVIN_PROFILE, [], CONFIG);
    expect(raw.length).toBeGreaterThan(0);

    // Step 4: dedup + filter
    const deduped = filterAndDedup(raw, MARVIN_PROFILE);
    expect(deduped.length).toBeGreaterThan(0);

    // Step 5: format
    const block = formatContextBlock(deduped, MARVIN_PROFILE, CONFIG.context_block_header);
    expect(block).not.toBeNull();
    expect(block).toContain("## Retrieved Knowledge");
    expect(block!.length).toBeGreaterThan(50);
  });

  itInteg("pipeline returns null for a query with zero matching results", async () => {
    // Highly specific nonsense query unlikely to match anything
    const message = "xyzzy frobnicator quux quantum entanglement blockchain NFT";
    const vector = await embedText(message, CONFIG);
    const locationFilter = inferLocationFilter(message, MARVIN_PROFILE);

    const tightProfile: AgentProfile = {
      ...MARVIN_PROFILE,
      score_thresholds: { default: 0.99 },  // impossibly high — nothing passes
    };

    const raw = await searchKnowledge(vector, "marvin", tightProfile, locationFilter, CONFIG);
    const deduped = filterAndDedup(raw, tightProfile);
    const block = formatContextBlock(deduped, tightProfile, CONFIG.context_block_header);
    expect(block).toBeNull();
  });
});
