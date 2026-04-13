import type { PluginConfig } from "./config.js";

export class EmbedError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "EmbedError";
  }
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

export async function embedText(
  text: string,
  config: Pick<PluginConfig, "embedding_url" | "embedding_model" | "embedding_timeout_ms">
): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.embedding_timeout_ms);

  try {
    const response = await fetch(`${config.embedding_url}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.embedding_model, prompt: text }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new EmbedError(`Embedding HTTP error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as Record<string, unknown>;

    if (!Array.isArray(data["embedding"])) {
      throw new EmbedError("Invalid embedding response: missing 'embedding' field");
    }

    return data["embedding"] as number[];
  } catch (err: unknown) {
    if (err instanceof EmbedError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new EmbedError("Embedding timed out", err);
    }
    throw new EmbedError("Embedding request failed", err);
  } finally {
    clearTimeout(timer);
  }
}
