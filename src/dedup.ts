import type { AgentProfile, ScoreThresholds } from "./config.js";
import type { QdrantResult } from "./search.js";

/**
 * Get the score threshold for a given source type.
 * - Returns thresholds[sourceType] if defined
 * - Falls back to thresholds["default"] if defined
 * - Falls back to 0.5 if neither is defined
 */
export function scoreThresholdFor(sourceType: string, thresholds: ScoreThresholds): number {
  // Check if source type is explicitly defined
  if (sourceType in thresholds && thresholds[sourceType] !== undefined) {
    return thresholds[sourceType]!;
  }

  // Fall back to default threshold
  if (thresholds.default !== undefined) {
    return thresholds.default;
  }

  // Final fallback
  return 0.5;
}

/**
 * Filter and deduplicate Qdrant search results.
 *
 * Steps in order:
 * 1. Score filter: keep only hits where score >= scoreThresholdFor(hit.payload.source_type, profile.score_thresholds)
 * 2. Dedup by source: group hits by hit.payload.source, keep only the highest-scoring hit per source
 * 3. Sort remaining hits by score descending
 * 4. Take top profile.top_k results
 * 5. Return the final array
 */
export function filterAndDedup(hits: QdrantResult[], profile: AgentProfile): QdrantResult[] {
  // Step 1: Score filter
  const filtered = hits.filter((hit) => {
    // Support both "type" (current indexer) and "source_type" (spec / future indexer)
    const sourceType = hit.payload.source_type ?? hit.payload.type ?? "unknown";
    const threshold = scoreThresholdFor(sourceType, profile.score_thresholds);
    return hit.score >= threshold;
  });

  // Step 2: Dedup by source (keep highest-scoring hit per source)
  const dedupMap = new Map<string, QdrantResult>();
  for (const hit of filtered) {
    const source = hit.payload.source;
    const existing = dedupMap.get(source);
    if (!existing || hit.score > existing.score) {
      dedupMap.set(source, hit);
    }
  }

  // Step 3: Sort by score descending
  const sorted = Array.from(dedupMap.values()).sort((a, b) => b.score - a.score);

  // Step 4: Take top_k results
  const topK = sorted.slice(0, profile.top_k);

  // Step 5: Return
  return topK;
}
