import { describe, it, expect } from "vitest";
import {
  mergeProfileWithDefaults,
  DEFAULT_PROFILE,
  validateProfileSchema,
} from "../src/config.js";
import type { AgentProfile } from "../src/config.js";

describe("mergeProfileWithDefaults", () => {
  it("returns full defaults when given empty object", () => {
    const result = mergeProfileWithDefaults({});
    expect(result).toEqual(DEFAULT_PROFILE);
  });

  it("overrides only the provided fields", () => {
    const result = mergeProfileWithDefaults({ top_k: 10 });
    expect(result.top_k).toBe(10);
    expect(result.max_tokens).toBe(DEFAULT_PROFILE.max_tokens);
    expect(result.enabled).toBe(true);
  });

  it("merges score_thresholds: partial override preserves missing keys", () => {
    const result = mergeProfileWithDefaults({
      score_thresholds: { ha_entity: 0.35 },
    });
    expect(result.score_thresholds.ha_entity).toBe(0.35);
    expect(result.score_thresholds.default).toBe(DEFAULT_PROFILE.score_thresholds.default);
  });

  it("merges keyword_map over empty default", () => {
    const result = mergeProfileWithDefaults({
      keyword_map: { yarychiv: ["yarychiv", "яричів"] },
    });
    expect(result.keyword_map.yarychiv).toEqual(["yarychiv", "яричів"]);
  });

  it("applies gateway defaults between DEFAULT_PROFILE and partial", () => {
    // Gateway sets top_k=8; partial doesn't override it → result is 8
    const result = mergeProfileWithDefaults({}, { top_k: 8, max_tokens: 3000, min_embed_tokens: 5, score_thresholds: { default: 0.5 }, context_inference: true });
    expect(result.top_k).toBe(8);
    expect(result.max_tokens).toBe(3000);
  });

  it("profile partial overrides gateway defaults", () => {
    // Profile sets top_k=12, gateway had 8 → profile wins
    const result = mergeProfileWithDefaults({ top_k: 12 }, { top_k: 8, max_tokens: 3000, min_embed_tokens: 5, score_thresholds: { default: 0.5 }, context_inference: true });
    expect(result.top_k).toBe(12);
  });

  it("gateway score_thresholds merged with DEFAULT_PROFILE thresholds", () => {
    const gw = { top_k: 5, max_tokens: 2000, min_embed_tokens: 5, score_thresholds: { ha_entity: 0.38 }, context_inference: true };
    const result = mergeProfileWithDefaults({}, gw);
    expect(result.score_thresholds.ha_entity).toBe(0.38);
    expect(result.score_thresholds.default).toBe(0.5); // still from DEFAULT_PROFILE
  });

  it("preserves agent_ids array", () => {
    const result = mergeProfileWithDefaults({ agent_ids: ["*", "marvin"] });
    expect(result.agent_ids).toEqual(["*", "marvin"]);
  });

  it("enabled: false is preserved", () => {
    const result = mergeProfileWithDefaults({ enabled: false });
    expect(result.enabled).toBe(false);
  });
});

describe("validateProfileSchema", () => {
  it("accepts a valid full profile", () => {
    const profile: AgentProfile = {
      ...DEFAULT_PROFILE,
      top_k: 6,
      agent_ids: ["*", "marvin"],
      keyword_map: { yarychiv: ["yarychiv"] },
    };
    expect(() => validateProfileSchema(profile)).not.toThrow();
  });

  it("rejects top_k < 1", () => {
    expect(() => validateProfileSchema({ ...DEFAULT_PROFILE, top_k: 0 })).toThrow();
  });

  it("rejects top_k > 20", () => {
    expect(() => validateProfileSchema({ ...DEFAULT_PROFILE, top_k: 21 })).toThrow();
  });

  it("rejects negative score threshold", () => {
    expect(() =>
      validateProfileSchema({
        ...DEFAULT_PROFILE,
        score_thresholds: { default: -0.1 },
      })
    ).toThrow();
  });

  it("rejects score threshold > 1", () => {
    expect(() =>
      validateProfileSchema({
        ...DEFAULT_PROFILE,
        score_thresholds: { default: 1.5 },
      })
    ).toThrow();
  });

  it("rejects min_embed_tokens < 1", () => {
    expect(() =>
      validateProfileSchema({ ...DEFAULT_PROFILE, min_embed_tokens: 0 })
    ).toThrow();
  });

  it("rejects max_tokens < 100", () => {
    expect(() =>
      validateProfileSchema({ ...DEFAULT_PROFILE, max_tokens: 50 })
    ).toThrow();
  });
});
