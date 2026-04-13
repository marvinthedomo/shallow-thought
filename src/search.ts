import { AgentProfile, PluginConfig } from "./config";

/**
 * Qdrant payload structure for indexed knowledge items
 */
export interface QdrantPayload {
  source: string;
  // Current indexer uses "type"; "source_type" is the canonical spec name — both accepted
  type?: string;
  source_type?: string;
  agent_id?: string;
  location?: string;
  tags?: string[];
  text: string;
  indexed_at: string;
  chunk_index?: number;
  heading?: string;
  file_hash?: string;
}

/**
 * Qdrant search result with similarity score
 */
export interface QdrantResult {
  id: string | number;
  score: number;
  payload: QdrantPayload;
}

/**
 * Custom error for search operations
 */
export class SearchError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "SearchError";
  }
}

/**
 * Filter condition for Qdrant query
 */
interface FilterCondition {
  key: string;
  match: { any?: string[]; value?: string };
}

/**
 * Qdrant search request body structure
 */
interface QdrantSearchRequest {
  vector: number[];
  limit: number;
  with_payload: boolean;
  filter?: {
    must?: FilterCondition[];
    must_not?: FilterCondition[];
  };
}

/**
 * Qdrant search response structure
 */
interface QdrantSearchResponse {
  result: Array<{
    id: string | number;
    score: number;
    payload: QdrantPayload;
  }>;
}

/**
 * Query Qdrant vector database with an embedding vector and payload filters
 * derived from the agent's scope profile.
 *
 * @param vector - The embedding vector to search with
 * @param agentId - The agent ID performing the search
 * @param profile - The agent's scope profile with filtering preferences
 * @param locationFilter - Optional location filter (empty = no location filtering)
 * @param config - Plugin configuration with Qdrant connection details
 * @returns Array of search results sorted by relevance score
 * @throws SearchError on HTTP errors, timeouts, or network failures
 */
export async function searchKnowledge(
  vector: number[],
  agentId: string,
  profile: AgentProfile,
  locationFilter: string[],
  config: PluginConfig
): Promise<QdrantResult[]> {
  const mustConditions: FilterCondition[] = [];
  const mustNotConditions: FilterCondition[] = [];

  // Build must conditions from profile
  // Note: current indexer uses "type" field; future re-index will use "source_type".
  // We try "type" first (current reality), with "source_type" as the spec field name.
  if (profile.include_types.length > 0) {
    mustConditions.push({
      key: "type",
      match: { any: profile.include_types },
    });
  }

  // Build must_not conditions from excluded types
  if (profile.exclude_types.length > 0) {
    mustNotConditions.push({
      key: "type",
      match: { any: profile.exclude_types },
    });
  }

  // Agent ID filter — only apply if profile.agent_ids doesn't include "*"
  // (current index has no agent_id field; skip filter when wildcard is present)
  if (profile.agent_ids.length > 0 && !profile.agent_ids.includes("*")) {
    mustConditions.push({
      key: "agent_id",
      match: { any: profile.agent_ids },
    });
  }

  // Location filtering (if provided and field exists in index)
  if (locationFilter.length > 0) {
    mustConditions.push({
      key: "location",
      match: { any: locationFilter },
    });
  }

  // Required tags (each tag is an individual must condition)
  for (const tag of profile.tags_require) {
    mustConditions.push({
      key: "tags",
      match: { value: tag },
    });
  }

  // Excluded tags (each tag is an individual must_not condition)
  for (const tag of profile.tags_exclude) {
    mustNotConditions.push({
      key: "tags",
      match: { value: tag },
    });
  }

  // Build request body
  const requestBody: QdrantSearchRequest = {
    vector,
    limit: profile.top_k * 3,
    with_payload: true,
  };

  // Only add filter if there are conditions
  if (mustConditions.length > 0 || mustNotConditions.length > 0) {
    const filter: { must?: FilterCondition[]; must_not?: FilterCondition[] } = {};

    if (mustConditions.length > 0) {
      filter.must = mustConditions;
    }

    if (mustNotConditions.length > 0) {
      filter.must_not = mustNotConditions;
    }

    requestBody.filter = filter;
  }

  // Prepare request with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.qdrant_timeout_ms);

  try {
    const url = `${config.qdrant_url}/collections/${config.collection}/points/search`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new SearchError(`Qdrant HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as QdrantSearchResponse;
    return data.result;
  } catch (error: unknown) {
    // Handle abort (timeout)
    if (error instanceof Error && error.name === "AbortError") {
      throw new SearchError("Qdrant search timed out", error);
    }

    // Handle SearchError (already thrown)
    if (error instanceof SearchError) {
      throw error;
    }

    // Handle other errors (network, JSON parsing, etc.)
    throw new SearchError("Qdrant search failed", error);
  } finally {
    clearTimeout(timeoutId);
  }
}
