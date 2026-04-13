import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadProfile, inferLocationFilter } from "../src/scope.js";
import { DEFAULT_PROFILE } from "../src/config.js";
import type { AgentProfile, PluginConfig } from "../src/config.js";

const BASE_CONFIG: PluginConfig = {
  qdrant_url: "http://127.0.0.1:6333",
  collection: "knowledge",
  embedding_url: "http://127.0.0.1:11434",
  embedding_model: "bge-m3",
  embedding_timeout_ms: 3000,
  qdrant_timeout_ms: 2000,
  profile_dir: "",     // overridden per test
  context_block_header: "## Retrieved Knowledge",
  fail_open: true,
  debug_log: false,
  defaults: {
    top_k: 5,
    max_tokens: 2000,
    min_embed_tokens: 5,
    score_thresholds: { default: 0.5 },
    context_inference: true,
  },
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shallow-thought-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---

describe("loadProfile", () => {
  it("returns merged defaults when profile file does not exist", async () => {
    const config = { ...BASE_CONFIG, profile_dir: tmpDir };
    const profile = await loadProfile("unknown-agent", config);
    expect(profile).toEqual(DEFAULT_PROFILE);
  });

  it("loads and merges a partial profile from disk", async () => {
    const config = { ...BASE_CONFIG, profile_dir: tmpDir };
    const partial = { top_k: 8, enabled: false };
    fs.writeFileSync(
      path.join(tmpDir, "marvin.json"),
      JSON.stringify(partial)
    );

    const profile = await loadProfile("marvin", config);
    expect(profile.top_k).toBe(8);
    expect(profile.enabled).toBe(false);
    expect(profile.max_tokens).toBe(DEFAULT_PROFILE.max_tokens);
  });

  it("returns defaults when profile file contains invalid JSON", async () => {
    const config = { ...BASE_CONFIG, profile_dir: tmpDir };
    fs.writeFileSync(path.join(tmpDir, "marvin.json"), "{ broken json");

    const profile = await loadProfile("marvin", config);
    expect(profile).toEqual(DEFAULT_PROFILE);
  });

  it("returns defaults when profile fails schema validation", async () => {
    const config = { ...BASE_CONFIG, profile_dir: tmpDir };
    fs.writeFileSync(
      path.join(tmpDir, "marvin.json"),
      JSON.stringify({ top_k: 999 })   // exceeds max of 20
    );

    const profile = await loadProfile("marvin", config);
    expect(profile.top_k).toBe(DEFAULT_PROFILE.top_k);
  });

  it("loads keyword_map from profile", async () => {
    const config = { ...BASE_CONFIG, profile_dir: tmpDir };
    const partial = {
      keyword_map: { yarychiv: ["yarychiv", "яричів", "яричеві"] },
    };
    fs.writeFileSync(path.join(tmpDir, "marvin.json"), JSON.stringify(partial));

    const profile = await loadProfile("marvin", config);
    expect(profile.keyword_map.yarychiv).toContain("яричів");
  });
});

// ---

describe("inferLocationFilter", () => {
  const profileWithMap: AgentProfile = {
    ...DEFAULT_PROFILE,
    context_inference: true,
    locations: [],
    keyword_map: {
      yarychiv: ["yarychiv", "яричів", "яричеві", "яричівський", "village"],
      pechersk: ["pechersk", "печерськ", "kyiv", "київ"],
    },
  };

  it("returns [] when context_inference is false", () => {
    const profile = { ...profileWithMap, context_inference: false };
    expect(inferLocationFilter("tell me about yarychiv", profile)).toEqual([]);
  });

  it("detects yarychiv keyword in message", () => {
    const result = inferLocationFilter("what is the temperature at yarychiv", profileWithMap);
    expect(result).toContain("yarychiv");
    expect(result).not.toContain("pechersk");
  });

  it("detects Ukrainian inflected form яричеві", () => {
    const result = inferLocationFilter("що відбувається в яричеві?", profileWithMap);
    expect(result).toContain("yarychiv");
  });

  it("detects pechersk keyword", () => {
    const result = inferLocationFilter("lights at pechersk", profileWithMap);
    expect(result).toContain("pechersk");
    expect(result).not.toContain("yarychiv");
  });

  it("returns both locations when both keywords present", () => {
    const result = inferLocationFilter("compare yarychiv and pechersk temperature", profileWithMap);
    expect(result).toContain("yarychiv");
    expect(result).toContain("pechersk");
  });

  it("returns [] when no keywords match", () => {
    const result = inferLocationFilter("what time is it", profileWithMap);
    expect(result).toEqual([]);
  });

  it("intersection: profile.locations limits inference even when keyword matches", () => {
    const profile: AgentProfile = {
      ...profileWithMap,
      locations: ["yarychiv"],  // only yarychiv allowed
    };
    // user mentions pechersk — but profile doesn't allow it
    const result = inferLocationFilter("lights at pechersk", profile);
    expect(result).toEqual([]);
  });

  it("intersection: both locations in profile, one keyword matches → only that one returned", () => {
    const profile: AgentProfile = {
      ...profileWithMap,
      locations: ["yarychiv", "pechersk"],
    };
    const result = inferLocationFilter("yarychiv temperature", profile);
    expect(result).toEqual(["yarychiv"]);
  });

  it("intersection: profile.locations=[] (all allowed), keyword matches → returned", () => {
    const profile: AgentProfile = { ...profileWithMap, locations: [] };
    const result = inferLocationFilter("yarychiv temperature", profile);
    expect(result).toContain("yarychiv");
  });

  it("matching is case-insensitive", () => {
    const result = inferLocationFilter("What is happening in YARYCHIV today", profileWithMap);
    expect(result).toContain("yarychiv");
  });

  it("empty keyword_map returns []", () => {
    const profile: AgentProfile = { ...profileWithMap, keyword_map: {} };
    const result = inferLocationFilter("yarychiv temperature", profile);
    expect(result).toEqual([]);
  });
});
