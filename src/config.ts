export interface ScoreThresholds {
  default?: number;
  [sourceType: string]: number | undefined;
}

export interface KeywordMap {
  [location: string]: string[];
}

export interface AgentProfile {
  enabled: boolean;
  top_k: number;
  max_tokens: number;
  min_embed_tokens: number;
  include_types: string[];
  exclude_types: string[];
  locations: string[];
  agent_ids: string[];
  tags_require: string[];
  tags_exclude: string[];
  score_thresholds: ScoreThresholds;
  keyword_map: KeywordMap;
  context_inference: boolean;
}

export interface PluginConfigDefaults {
  top_k: number;
  max_tokens: number;
  min_embed_tokens: number;
  score_thresholds: ScoreThresholds;
  context_inference: boolean;
}

export interface PluginConfig {
  qdrant_url: string;
  collection: string;
  embedding_url: string;
  embedding_model: string;
  embedding_timeout_ms: number;
  qdrant_timeout_ms: number;
  profile_dir: string;
  context_block_header: string;
  fail_open: boolean;
  debug_log: boolean;
  /** Over-fetch multiplier: Qdrant limit = top_k * search_multiplier (before dedup). Default 5. */
  search_multiplier: number;
  defaults: PluginConfigDefaults;
}

/** Expand leading ~ to HOME directory. path.join() does not expand tildes. */
export function expandTilde(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return p.replace("~", process.env["HOME"] ?? "/tmp");
  }
  return p;
}

export const DEFAULT_PROFILE: AgentProfile = {
  enabled: true,
  top_k: 5,
  max_tokens: 2000,
  min_embed_tokens: 5,
  include_types: [],
  exclude_types: [],
  locations: [],
  agent_ids: ["*"],
  tags_require: [],
  tags_exclude: [],
  score_thresholds: { default: 0.5 },
  keyword_map: {},
  context_inference: true,
};

/**
 * Merge a partial profile over DEFAULT_PROFILE, with optional gateway-level defaults
 * (from openclaw.json plugins.entries.shallow-thought.config.defaults) layered in between.
 *
 * Priority (highest to lowest):
 *   1. Per-agent profile file fields
 *   2. Gateway config defaults (config.defaults in openclaw.json)
 *   3. Hardcoded DEFAULT_PROFILE
 */
export function mergeProfileWithDefaults(
  partial: Partial<AgentProfile>,
  gatewayDefaults?: Partial<PluginConfigDefaults>
): AgentProfile {
  // Build the effective base: DEFAULT_PROFILE overridden by gateway defaults
  const base: AgentProfile = {
    ...DEFAULT_PROFILE,
    ...(gatewayDefaults !== undefined
      ? {
          top_k: gatewayDefaults.top_k ?? DEFAULT_PROFILE.top_k,
          max_tokens: gatewayDefaults.max_tokens ?? DEFAULT_PROFILE.max_tokens,
          min_embed_tokens: gatewayDefaults.min_embed_tokens ?? DEFAULT_PROFILE.min_embed_tokens,
          context_inference: gatewayDefaults.context_inference ?? DEFAULT_PROFILE.context_inference,
          score_thresholds: {
            ...DEFAULT_PROFILE.score_thresholds,
            ...(gatewayDefaults.score_thresholds ?? {}),
          },
        }
      : {}),
  };

  return {
    enabled: partial.enabled !== undefined ? partial.enabled : base.enabled,
    top_k: partial.top_k !== undefined ? partial.top_k : base.top_k,
    max_tokens: partial.max_tokens !== undefined ? partial.max_tokens : base.max_tokens,
    min_embed_tokens:
      partial.min_embed_tokens !== undefined ? partial.min_embed_tokens : base.min_embed_tokens,
    include_types:
      partial.include_types !== undefined ? partial.include_types : base.include_types,
    exclude_types:
      partial.exclude_types !== undefined ? partial.exclude_types : base.exclude_types,
    locations: partial.locations !== undefined ? partial.locations : base.locations,
    agent_ids: partial.agent_ids !== undefined ? partial.agent_ids : base.agent_ids,
    tags_require: partial.tags_require !== undefined ? partial.tags_require : base.tags_require,
    tags_exclude: partial.tags_exclude !== undefined ? partial.tags_exclude : base.tags_exclude,
    score_thresholds: {
      ...base.score_thresholds,
      ...(partial.score_thresholds ?? {}),
    },
    keyword_map: {
      ...base.keyword_map,
      ...(partial.keyword_map ?? {}),
    },
    context_inference:
      partial.context_inference !== undefined ? partial.context_inference : base.context_inference,
  };
}

export function validateProfileSchema(profile: AgentProfile): void {
  if (profile.top_k < 1 || profile.top_k > 20) {
    throw new Error(
      `Invalid profile schema: top_k must be between 1 and 20, got ${profile.top_k}`
    );
  }

  if (profile.max_tokens < 100) {
    throw new Error(
      `Invalid profile schema: max_tokens must be at least 100, got ${profile.max_tokens}`
    );
  }

  if (profile.min_embed_tokens < 1) {
    throw new Error(
      `Invalid profile schema: min_embed_tokens must be at least 1, got ${profile.min_embed_tokens}`
    );
  }

  // Validate score_thresholds numeric values
  for (const [key, value] of Object.entries(profile.score_thresholds)) {
    if (value !== undefined && (typeof value !== "number" || value < 0 || value > 1)) {
      throw new Error(
        `Invalid profile schema: score_thresholds["${key}"] must be a number between 0 and 1, got ${value}`
      );
    }
  }
}
