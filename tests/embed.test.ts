import { describe, it, expect, vi, beforeEach } from "vitest";
import { wordCount, embedText, EmbedError } from "../src/embed.js";
import type { PluginConfig } from "../src/config.js";

const BASE_CONFIG: PluginConfig = {
  qdrant_url: "http://127.0.0.1:6333",
  collection: "knowledge",
  embedding_url: "http://127.0.0.1:11434",
  embedding_model: "bge-m3",
  embedding_timeout_ms: 3000,
  qdrant_timeout_ms: 2000,
  profile_dir: "/tmp/shallow-thought-test",
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

// ---

describe("wordCount", () => {
  it("counts whitespace-separated words", () => {
    expect(wordCount("hello world foo")).toBe(3);
  });

  it("returns 0 for empty string", () => {
    expect(wordCount("")).toBe(0);
  });

  it("returns 0 for whitespace-only string", () => {
    expect(wordCount("   ")).toBe(0);
  });

  it("counts a single word", () => {
    expect(wordCount("yes")).toBe(1);
  });

  it("handles Ukrainian text", () => {
    expect(wordCount("яричів яке температура")).toBe(3);
  });

  it("handles mixed punctuation", () => {
    expect(wordCount("Hello, world! How are you?")).toBe(5);
  });
});

// ---

describe("embedText", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a 1024-dim vector on success", async () => {
    const fakeVector = Array(1024).fill(0.1);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: fakeVector }),
    } as Response);

    const result = await embedText("what is the temperature at yarychiv", BASE_CONFIG);
    expect(result).toHaveLength(1024);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it("throws EmbedError on non-OK HTTP response", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    } as Response);

    await expect(
      embedText("query text", BASE_CONFIG)
    ).rejects.toThrow(EmbedError);
  });

  it("throws EmbedError on network failure", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      embedText("query text", BASE_CONFIG)
    ).rejects.toThrow(EmbedError);
  });

  it("throws EmbedError on timeout (AbortError)", async () => {
    global.fetch = vi.fn().mockRejectedValue(
      Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
    );

    await expect(
      embedText("query text", BASE_CONFIG)
    ).rejects.toThrow(EmbedError);
  });

  it("throws EmbedError when response missing embedding field", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ not_embedding: [] }),
    } as Response);

    await expect(
      embedText("query text", BASE_CONFIG)
    ).rejects.toThrow(EmbedError);
  });

  it("passes correct request body to Ollama", async () => {
    const fakeVector = Array(1024).fill(0.0);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: fakeVector }),
    } as Response);

    await embedText("test query", BASE_CONFIG);

    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain("/api/embeddings");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("bge-m3");
    expect(body.prompt).toBe("test query");
  });
});
