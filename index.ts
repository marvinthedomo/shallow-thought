/**
 * shallow-thought — OpenClaw plugin entry point
 * T8: before_prompt_build hook wiring
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { expandTilde } from "./src/config.js";
import type { PluginConfig } from "./src/config.js";
import { EmbedError, embedText, wordCount } from "./src/embed.js";
import { loadProfile, inferLocationFilter } from "./src/scope.js";
import { SearchError, searchKnowledge } from "./src/search.js";
import { filterAndDedup } from "./src/dedup.js";
import { formatContextBlock } from "./src/format.js";

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

function buildConfig(raw: Record<string, unknown>): PluginConfig {
  const defaults: PluginConfig = {
    qdrant_url: "http://127.0.0.1:6333",
    collection: "knowledge",
    embedding_url: "http://127.0.0.1:11434",
    embedding_model: "bge-m3",
    embedding_timeout_ms: 3000,
    qdrant_timeout_ms: 2000,
    profile_dir: `${process.env["HOME"] ?? "~"}/.openclaw/workspace/config/shallow-thought`,
    context_block_header: "## Retrieved Knowledge",
    fail_open: true,
    debug_log: false,
    search_multiplier: 5,
    defaults: {
      top_k: 5,
      max_tokens: 2000,
      min_embed_tokens: 5,
      score_thresholds: { default: 0.5 },
      context_inference: true,
    },
  };
  const r = raw as Partial<PluginConfig>;
  return {
    ...defaults,
    ...r,
    // Nested merge: don't let raw.defaults replace the entire defaults object
    defaults: {
      ...defaults.defaults,
      ...(r.defaults ?? {}),
      // score_thresholds also needs deep merge
      score_thresholds: {
        ...defaults.defaults.score_thresholds,
        ...(r.defaults?.score_thresholds ?? {}),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Message extraction helper
// ---------------------------------------------------------------------------

function extractLastUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg != null &&
      typeof msg === "object" &&
      "role" in msg &&
      (msg as { role: unknown }).role === "user"
    ) {
      const content = (msg as { content: unknown }).content;
      if (typeof content === "string") return content;
      // Handle array content blocks
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block != null &&
            typeof block === "object" &&
            "type" in block &&
            (block as { type: unknown }).type === "text" &&
            "text" in block
          ) {
            return String((block as { text: unknown }).text);
          }
        }
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "shallow-thought",
  name: "Shallow Thought",
  description: "Qdrant-backed RAG knowledge injection for OpenClaw agents",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      qdrant_url: { type: "string" },
      collection: { type: "string" },
      embedding_url: { type: "string" },
      embedding_model: { type: "string" },
      embedding_timeout_ms: { type: "integer", minimum: 100 },
      qdrant_timeout_ms: { type: "integer", minimum: 100 },
      profile_dir: { type: "string" },
      context_block_header: { type: "string" },
      fail_open: { type: "boolean" },
      debug_log: { type: "boolean" },
      defaults: {
        type: "object",
        additionalProperties: false,
        properties: {
          top_k: { type: "integer", minimum: 1, maximum: 20 },
          max_tokens: { type: "integer", minimum: 100 },
          min_embed_tokens: { type: "integer", minimum: 1 },
          score_thresholds: { type: "object" },
          context_inference: { type: "boolean" },
        },
      },
    },
  },

  register(api) {
    // ------------------------------------------------------------------
    // before_prompt_build — RAG injection hook
    // ------------------------------------------------------------------
    api.registerHook("before_prompt_build", async (ctx) => {
      const t0 = Date.now();

      // 1. Extract agentId
      const agentId =
        (ctx as { agentId?: string }).agentId ?? "unknown";

      // 2. Build PluginConfig with defaults
      const pluginConfig = buildConfig(api.pluginConfig as Record<string, unknown>);

      const debug = pluginConfig.debug_log;

      if (debug) {
        api.logger.debug(`[shallow-thought] start agentId=${agentId} t=${t0}`);
      }

      // 3. Load agent profile
      const profile = await loadProfile(agentId, pluginConfig);

      if (debug) {
        api.logger.debug(
          `[shallow-thought] profile loaded enabled=${profile.enabled} t+${Date.now() - t0}ms`
        );
      }

      // 4. Skip if disabled
      if (!profile.enabled) {
        if (debug) api.logger.debug("[shallow-thought] profile disabled, skipping");
        return {};
      }

      // 5. Extract last user message
      const message = extractLastUserMessage(
        (ctx as { messages?: unknown }).messages
      );

      if (debug) {
        api.logger.debug(
          `[shallow-thought] message extracted length=${message.length} words=${wordCount(message)} t+${Date.now() - t0}ms`
        );
      }

      // 6. Skip short messages
      if (wordCount(message) < profile.min_embed_tokens) {
        if (debug) {
          api.logger.debug(
            `[shallow-thought] message too short (${wordCount(message)} < ${profile.min_embed_tokens}), skipping`
          );
        }
        return {};
      }

      // 7. Embed message
      let vector: number[];
      try {
        vector = await embedText(message, pluginConfig);
        if (debug) {
          api.logger.debug(
            `[shallow-thought] embedding done dims=${vector.length} t+${Date.now() - t0}ms`
          );
        }
      } catch (err) {
        if (err instanceof EmbedError) {
          if (pluginConfig.fail_open) {
            api.logger.warn(`[shallow-thought] embed failed (fail_open): ${err.message}`);
            return {};
          }
          throw err;
        }
        throw err;
      }

      // 8. Infer location filter
      const locationFilter = inferLocationFilter(message, profile);
      if (debug) {
        api.logger.debug(
          `[shallow-thought] locationFilter=${JSON.stringify(locationFilter)} t+${Date.now() - t0}ms`
        );
      }

      // 9. Search Qdrant
      let hits;
      try {
        hits = await searchKnowledge(vector, agentId, profile, locationFilter, pluginConfig);
        if (debug) {
          api.logger.debug(
            `[shallow-thought] search returned ${hits.length} hits t+${Date.now() - t0}ms`
          );
        }
      } catch (err) {
        if (err instanceof SearchError) {
          if (pluginConfig.fail_open) {
            api.logger.warn(`[shallow-thought] search failed (fail_open): ${err.message}`);
            return {};
          }
          throw err;
        }
        throw err;
      }

      // 10. Filter and deduplicate
      const deduped = filterAndDedup(hits, profile);
      if (debug) {
        api.logger.debug(
          `[shallow-thought] after dedup: ${deduped.length} results t+${Date.now() - t0}ms`
        );
      }

      // 11. Format context block
      const result = formatContextBlock(deduped, profile, pluginConfig.context_block_header);

      if (debug) {
        api.logger.debug(
          `[shallow-thought] formatContextBlock result=${result === null ? "null" : `${result.length} chars`} t+${Date.now() - t0}ms`
        );
      }

      // 12. Skip if nothing to inject
      if (result === null) {
        return {};
      }

      // 13. Return context for prepending
      return { prependContext: result };
    }, { name: "rag-inject" });

    // ------------------------------------------------------------------
    // gateway_stop — cleanup hook
    // ------------------------------------------------------------------
    api.registerHook("gateway_stop", () => {
      // hook name: rag-cleanup
      api.logger.debug("[shallow-thought] shutting down");
    }, { name: "rag-cleanup" });
  },
});
