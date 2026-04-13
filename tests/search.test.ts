import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchKnowledge, SearchError } from "../src/search.js";
import { DEFAULT_PROFILE } from "../src/config.js";
import type { PluginConfig, AgentProfile } from "../src/config.js";

const BASE_CONFIG: PluginConfig = {
  qdrant_url: "http://127.0.0.1:6333",
  collection: "knowledge",
  embedding_url: "http://127.0.0.1:11434",
  embedding_model: "bge-m3",
  embedding_timeout_ms: 3000,
  qdrant_timeout_ms: 2000,
  search_multiplier: 5,
  profile_dir: "/tmp/test",
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

describe("searchKnowledge", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn();
  });

  const mockFetchSuccess = (data: any) => {
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => data,
    });
  };

  const getRequestBody = () => {
    const call = (global.fetch as any).mock.calls[0];
    return JSON.parse(call[1].body as string);
  };

  describe("Filter Construction", () => {
    it("1. No filters when include_types=[], agent_ids=['*'], no location", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter).toBeUndefined();
    });

    it("2. include_types=['memory','skill']", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, include_types: ["memory", "skill"] };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must).toContainEqual({ key: "type", match: { any: ["memory", "skill"] } });
    });

    it("3. exclude_types=['ha_entity']", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, exclude_types: ["ha_entity"] };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must_not).toContainEqual({ key: "type", match: { any: ["ha_entity"] } });
    });

    it("4. agent_ids=['marvin'] (no '*')", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, agent_ids: ["marvin"] };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must).toContainEqual({ key: "agent_id", match: { any: ["marvin"] } });
    });

    it("5. agent_ids=['*', 'marvin']", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, agent_ids: ["*", "marvin"] };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      const hasAgentId = body.filter?.must?.some((c: any) => c.key === "agent_id");
      expect(hasAgentId).not.toBe(true);
    });

    it("6. locationFilter=['yarychiv']", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE };
      await searchKnowledge([0.1], "marvin", profile, ["yarychiv"], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must).toContainEqual({ key: "location", match: { any: ["yarychiv"] } });
    });

    it("7. locationFilter=[]", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      const hasLocation = body.filter?.must?.some((c: any) => c.key === "location");
      expect(hasLocation).not.toBe(true);
    });

    it("8. tags_require=['solar','important']", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, tags_require: ["solar", "important"] };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must).toContainEqual({ key: "tags", match: { value: "solar" } });
      expect(body.filter.must).toContainEqual({ key: "tags", match: { value: "important" } });
    });

    it("9. tags_exclude=['archive']", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, tags_exclude: ["archive"] };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must_not).toContainEqual({ key: "tags", match: { value: "archive" } });
    });

    it("10. Combined: include_types + location + tags", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { 
        ...DEFAULT_PROFILE, 
        include_types: ["memory"], 
        tags_require: ["solar"] 
      };
      await searchKnowledge([0.1], "marvin", profile, ["yarychiv"], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.filter.must).toContainEqual({ key: "type", match: { any: ["memory"] } });
      expect(body.filter.must).toContainEqual({ key: "location", match: { any: ["yarychiv"] } });
      expect(body.filter.must).toContainEqual({ key: "tags", match: { value: "solar" } });
    });
  });

  describe("Limit and Score Threshold", () => {
    it("11. limit = top_k * search_multiplier", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { ...DEFAULT_PROFILE, top_k: 10 };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.limit).toBe(10 * BASE_CONFIG.search_multiplier);
    });

    it("12. score_threshold is the minimum value from score_thresholds", async () => {
      mockFetchSuccess({ result: [] });
      const profile: AgentProfile = { 
        ...DEFAULT_PROFILE, 
        score_thresholds: { default: 0.7, memory: 0.3, skill: 0.5 } 
      };
      await searchKnowledge([0.1], "marvin", profile, [], BASE_CONFIG);
      
      const body = getRequestBody();
      expect(body.score_threshold).toBe(0.3);
    });
  });

  describe("Error Handling", () => {
    it("13. Non-OK HTTP response (500) -> throws SearchError", async () => {
      (global.fetch as any).mockResolvedValue({
        ok: false,
        status: 500,
      });
      await expect(searchKnowledge([0.1], "marvin", DEFAULT_PROFILE, [], BASE_CONFIG))
        .rejects.toThrow(SearchError);
    });

    it("14. Network error (ECONNREFUSED) -> throws SearchError", async () => {
      (global.fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));
      await expect(searchKnowledge([0.1], "marvin", DEFAULT_PROFILE, [], BASE_CONFIG))
        .rejects.toThrow(SearchError);
    });

    it("15. AbortError (timeout) -> throws SearchError", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      (global.fetch as any).mockRejectedValue(abortError);
      await expect(searchKnowledge([0.1], "marvin", DEFAULT_PROFILE, [], BASE_CONFIG))
        .rejects.toThrow(SearchError);
    });
  });

  describe("Success Path", () => {
    it("16. Valid response -> returns QdrantResult[]", async () => {
      const mockResults = [
        { id: 1, score: 0.9, payload: { text: "hit 1", source: "s1", indexed_at: "now" } },
        { id: 2, score: 0.8, payload: { text: "hit 2", source: "s2", indexed_at: "now" } },
      ];
      mockFetchSuccess({ result: mockResults });
      
      const results = await searchKnowledge([0.1], "marvin", DEFAULT_PROFILE, [], BASE_CONFIG);
      expect(results).toEqual(mockResults);
    });
  });
});
