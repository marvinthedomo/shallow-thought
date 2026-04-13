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
