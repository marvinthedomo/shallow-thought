import type { AgentProfile } from "./config.js";
import type { QdrantResult } from "./search.js";

export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
  return Math.floor(words.length * 1.3);
}

export function formatContextBlock(
  hits: QdrantResult[],
  profile: AgentProfile,
  header: string
): string | null {
  if (hits.length === 0) return null;

  let accumulated = estimateTokens(header);
  const parts: string[] = [header];
  let chunksAdded = 0;

  for (const hit of hits) {
    const { source, text } = hit.payload;
    const sourceType = hit.payload.source_type ?? hit.payload.type ?? "unknown";
    const attribution = `<!-- source: ${source} | score: ${hit.score.toFixed(2)} | type: ${sourceType} -->`;
    const attributionTokens = estimateTokens(attribution);

    const remaining = profile.max_tokens - accumulated;

    // Not even room for the attribution line — stop
    if (remaining <= attributionTokens) break;

    const textTokens = estimateTokens(text);
    const chunkTokens = attributionTokens + textTokens;

    if (accumulated + chunkTokens <= profile.max_tokens) {
      // Full chunk fits
      parts.push(`\n${attribution}\n${text}`);
      accumulated += chunkTokens;
      chunksAdded++;
    } else {
      // Partial chunk: truncate text at word boundary
      const budgetWords = Math.floor((remaining - attributionTokens) / 1.3);
      if (budgetWords <= 0) break;
      const words = text.trim().split(/\s+/).filter((w) => w.length > 0);
      const truncated = words.slice(0, budgetWords).join(" ");
      if (truncated.length > 0) {
        parts.push(`\n${attribution}\n${truncated}`);
        chunksAdded++;
      }
      break; // Always stop after a partial chunk
    }
  }

  if (chunksAdded === 0) return null;

  return parts.join("\n");
}
