# Shallow Thought — Plugin Specification

**Package:** `openclaw-shallow-thought`  
**Repo:** https://github.com/marvinthedomo/shallow-thought  
**Version:** 0.1.0  
**Status:** Draft — 2026-04-13 (rev 2)

---

## 1. Purpose

Shallow Thought is an OpenClaw plugin that automatically injects relevant knowledge into agent context before each LLM call. It queries a Qdrant vector database, retrieves the most relevant chunks for the current conversation, and prepends them to the agent's prompt via the `before_prompt_build` hook.

The name is an intentional inversion of Deep Thought — fast, practical answers rather than 7.5 million years of deliberation.

---

## 2. Architecture Overview

```
Agent turn starts
       │
       ▼
before_prompt_build hook fires
       │
       ▼
1. Embedding eligibility check
   └─ Message < min_embed_tokens (default: 5)?  → skip, return {}
   └─ Otherwise: embed user message via bge-m3 (Ollama)
       │
       ▼
2. Load agent scope profile (hot-reloaded from disk)
       │
       ▼
3. Build Qdrant filter
   ├─ Base filter: source_type, agent_ids, tags from profile
   └─ Context inference: scan message text against profile's keyword_map
      → intersection with profile.locations (never expands beyond allowed set)
       │
       ▼
4. Search Qdrant (dense vector similarity + payload filter)
       │
       ▼
5. Score filter (per-source-type thresholds) + dedup (highest score per source)
       │
       ▼
6. Format context block (with source attribution headers, visible to LLM)
       │
       ▼
7. Return { prependContext: "..." }
       │
       ▼
LLM call proceeds with knowledge injected
```

---

## 3. Knowledge Store

**Backend:** Qdrant (existing Docker container, port 6333)  
**Collection:** `knowledge` (existing, 1,197 vectors as of 2026-04-13)  
**Embedding model:** `bge-m3` via Ollama (1024-dim, multilingual EN/UK/RU)  
**Payload schema per vector:**

```json
{
  "source": "memory/2026-04-13.md",
  "source_type": "memory",
  "agent_id": "*",
  "location": "yarychiv",
  "tags": ["ha_entity", "climate"],
  "text": "...",
  "indexed_at": "2026-04-13T17:00:00Z"
}
```

`source_type` values:
- `memory` — daily/location notes from `memory/`
- `skill` — skill SKILL.md files
- `script` — automation scripts
- `ha_entity` — Home Assistant entity registry (terse — lower scores expected)
- `ha_automation` — Home Assistant automations
- `experience` — distilled knowledge from `experience_distiller.py`
- `config` — system config context

`agent_id` values:
- `*` — shared across all agents
- `marvin`, `eddie`, `ford`, etc. — agent-specific knowledge

---

## 4. Scope System

### 4A — Scope Profiles (hot-reloadable config files)

Each agent has an optional scope profile at:
```
~/.openclaw/workspace/config/shallow-thought/<agent_id>.json
```

This directory is **global** (not per-workspace). Agent scoping is handled by the `agent_ids` filter in the profile itself, so agents share the same profile directory without collision.

**Example — Marvin:**
```json
{
  "enabled": true,
  "top_k": 6,
  "max_tokens": 2000,
  "min_embed_tokens": 5,
  "include_types": ["memory", "ha_entity", "ha_automation", "experience", "skill"],
  "exclude_types": [],
  "locations": [],
  "agent_ids": ["*", "marvin"],
  "tags_require": [],
  "tags_exclude": [],
  "score_thresholds": {
    "default": 0.50,
    "ha_entity": 0.40,
    "ha_automation": 0.42,
    "memory": 0.52,
    "experience": 0.52
  },
  "keyword_map": {
    "yarychiv": ["yarychiv", "яричів", "яричеві", "яричівський", "village", "selo", "село"],
    "pechersk": ["pechersk", "печерськ", "kyiv", "київ", "pecherska"]
  },
  "context_inference": true
}
```

**Example — Eddie (task-focused, no HA noise):**
```json
{
  "enabled": true,
  "top_k": 4,
  "max_tokens": 1000,
  "min_embed_tokens": 5,
  "include_types": ["memory", "experience"],
  "exclude_types": ["ha_entity", "ha_automation"],
  "locations": [],
  "agent_ids": ["*", "eddie"],
  "score_thresholds": {
    "default": 0.55
  },
  "keyword_map": {},
  "context_inference": false
}
```

**Profile fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Enable/disable injection for this agent |
| `top_k` | int | `5` | Max chunks to inject after dedup |
| `max_tokens` | int | `2000` | Token cap for the entire injected block |
| `min_embed_tokens` | int | `5` | Skip embedding if message word count < this (e.g. "yes", "do it") |
| `include_types` | string[] | `[]` (all) | Only include these `source_type` values |
| `exclude_types` | string[] | `[]` | Exclude these `source_type` values |
| `locations` | string[] | `[]` (all) | Allowed location set. Inference can only pick within this set. Empty = all locations allowed. |
| `agent_ids` | string[] | `["*"]` | Only include vectors with these `agent_id` values |
| `tags_require` | string[] | `[]` | Chunks must have ALL these tags |
| `tags_exclude` | string[] | `[]` | Chunks must not have ANY of these tags |
| `score_thresholds` | object | `{ default: 0.5 }` | Per-`source_type` score cutoffs. Falls back to `default` if type not listed. |
| `keyword_map` | object | `{}` | Maps location names to keyword arrays. Defined in profile — no hardcoded keywords in code. |
| `context_inference` | bool | `true` | Enable/disable keyword-based context inference for this agent |

**Hot-reload:** Plugin uses `fs.watchFile` on each profile path. Changes take effect within 1s, no restart required.

**Fallback:** If no profile file exists for an agent, fall back to global defaults from `plugins.entries.shallow-thought.config` in `openclaw.json`.

### 4B — Context Inference (automatic, per-turn)

When `context_inference: true`, the plugin scans the user message text against the agent's `keyword_map` and infers a location filter.

**Semantics — intersection, not override:**
- Profile `locations: []` (all) + message mentions "yarychiv" → filter to `yarychiv` only ✅
- Profile `locations: ["yarychiv"]` + message mentions "pechersk" → filter stays `yarychiv` only (pechersk not in allowed set) ✅
- Profile `locations: ["yarychiv", "pechersk"]` + message mentions "pechersk" → filter to `pechersk` only ✅

The rule: **profile defines the allowed location set; inference picks within it.** Inference never expands beyond what the profile permits.

**Keyword map in profile (not in code):**
The `keyword_map` is defined per-agent in the profile JSON. The plugin never hardcodes keywords. This means:
- New locations are added by editing the profile, not shipping a code change
- Inflected Ukrainian forms, typos, and aliases are all handled in one place
- Per-agent keyword sensitivity (Eddie doesn't need location inference at all → `context_inference: false`)

**Short-message bypass:**
If the user message word count is below `min_embed_tokens` (default: 5), the plugin skips embedding entirely and returns `{}`. This avoids wasting 200ms on "yes", "do it", "ok", "плюс" and similar confirming turns where retrieval would return noise anyway.

---

## 5. Dedup Strategy

After Qdrant returns candidates, dedup is applied before score filtering and formatting.

**Dedup key:** `source` field (e.g., `memory/2026-04-13.md`, `ha_entity:climate.yarychiv_living_room`)

**Rule:** Keep only the highest-scoring chunk per unique `source`. This prevents the same document from dominating the context block with multiple near-identical chunks.

**Order of operations:**
1. Collect all Qdrant results above minimum threshold for their `source_type`
2. Group by `source` → keep max-score chunk per group
3. Sort by score descending
4. Take top `top_k`
5. Format and token-cap

---

## 6. Plugin Config (`openclaw.json`)

```json
{
  "plugins": {
    "entries": {
      "shallow-thought": {
        "enabled": true,
        "config": {
          "qdrant_url": "http://127.0.0.1:6333",
          "collection": "knowledge",
          "embedding_url": "http://127.0.0.1:11434",
          "embedding_model": "bge-m3",
          "embedding_timeout_ms": 3000,
          "qdrant_timeout_ms": 2000,
          "profile_dir": "~/.openclaw/workspace/config/shallow-thought",
          "context_block_header": "## Retrieved Knowledge",
          "fail_open": true,
          "debug_log": false,
          "defaults": {
            "top_k": 5,
            "max_tokens": 2000,
            "min_embed_tokens": 5,
            "score_thresholds": { "default": 0.50 },
            "context_inference": true
          }
        }
      }
    }
  }
}
```

---

## 7. Output Format

The injected block is **visible to the LLM** — source attribution is intentional and useful for citation.

```
## Retrieved Knowledge
<!-- source: memory/yarychiv.md | score: 0.81 | type: memory -->
H700 humidifier at Yarychiv was turned off 2026-04-13. Re-enable automations April 17 at 10:00.

<!-- source: ha_entity:climate.yarychiv_living_room | score: 0.74 | type: ha_entity -->
Entity: climate.yarychiv_living_room | current_temp: 21°C | hvac_mode: off

<!-- source: memory/2026-04-12.md | score: 0.67 | type: memory -->
Solar curtailment threshold for Yarychiv is 240V grid voltage.
```

Notes:
- Source attribution headers (source, score, type) are **plain text visible to the model** — LLMs do not treat HTML comments as hidden. This is intentional: the model can use them for citations and source awareness.
- Chunks ordered by score descending
- Total block capped at `max_tokens` (counted approximately, not exact tokenization — use word count × 1.3 as a proxy)
- If the formatted block would exceed `max_tokens`, truncate the last chunk (not drop it entirely — partial context is better than none)
- Empty result set (all filtered out) → no `prependContext` returned at all

---

## 8. Hook Registration

```typescript
register(api) {
  api.registerHook("before_prompt_build", async (ctx) => {
    const agentId = ctx.agentId ?? "unknown";
    const profile = await loadProfile(agentId, pluginConfig);

    if (!profile.enabled) return {};

    const message = ctx.messages?.at(-1)?.content ?? "";
    if (wordCount(message) < profile.min_embed_tokens) return {};

    const context = await buildContext(message, agentId, profile, pluginConfig);
    if (!context) return {};

    return { prependContext: context };
  }, { priority: 10 });
}
```

- Uses `before_prompt_build` (preferred over deprecated `before_agent_start`)
- Returns `{}` silently on error when `fail_open: true`
- Never blocks the agent — all errors are swallowed with optional `debug_log` output

---

## 9. Plugin Manifest (`openclaw.plugin.json`)

```json
{
  "id": "shallow-thought",
  "name": "Shallow Thought",
  "description": "Qdrant-backed RAG knowledge injection for OpenClaw agents",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "qdrant_url":            { "type": "string" },
      "collection":            { "type": "string" },
      "embedding_url":         { "type": "string" },
      "embedding_model":       { "type": "string" },
      "embedding_timeout_ms":  { "type": "integer", "minimum": 100 },
      "qdrant_timeout_ms":     { "type": "integer", "minimum": 100 },
      "profile_dir":           { "type": "string" },
      "context_block_header":  { "type": "string" },
      "fail_open":             { "type": "boolean" },
      "debug_log":             { "type": "boolean" },
      "defaults": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "top_k":              { "type": "integer", "minimum": 1, "maximum": 20 },
          "max_tokens":         { "type": "integer", "minimum": 100 },
          "min_embed_tokens":   { "type": "integer", "minimum": 1 },
          "score_thresholds":   { "type": "object" },
          "context_inference":  { "type": "boolean" }
        }
      }
    }
  }
}
```

---

## 10. Performance Budget

| Step | Target | Hard limit |
|---|---|---|
| Eligibility check (word count) | < 1ms | — |
| Profile load (cached, hot-reload) | < 1ms | — |
| Embedding call (bge-m3) | < 200ms | 3,000ms |
| Qdrant search | < 50ms | 2,000ms |
| Dedup + format | < 5ms | — |
| **Total hook overhead** | **< 300ms** | **5,000ms** |

If embedding or search exceeds their hard limit, hook returns `{}` immediately. The agent is never blocked by RAG latency.

---

## 11. Non-Goals (v0.1)

- No write path — this plugin only reads from Qdrant. Indexing stays in `rag_indexer.py`.
- No per-turn memory capture.
- No UI or admin panel.
- No cloud deployment — local Qdrant only.
- No hybrid search (sparse + dense) — pure dense for v0.1. Reranking also post-v0.1.

---

## 12. File Layout

```
shallow-thought/
  package.json
  openclaw.plugin.json
  tsconfig.json
  index.ts                  # Plugin entry point + hook registration
  src/
    embed.ts                # bge-m3 embedding via Ollama
    search.ts               # Qdrant search with filter building
    scope.ts                # Profile loader, hot-reload, context inference
    dedup.ts                # Dedup + score filter
    format.ts               # Context block formatter + token cap
    config.ts               # Plugin config schema + defaults
  config/
    marvin.json.example
    eddie.json.example
  tests/
    embed.test.ts
    search.test.ts
    scope.test.ts
    dedup.test.ts
    format.test.ts
    integration.test.ts
  SPEC.md                   # This file
  README.md
```

---

## 13. Rollout Plan

1. ✅ Write spec → land in repo
2. Dev plan — task breakdown with estimates
3. Test cases — written before implementation
4. Implement `src/embed.ts` + `src/search.ts` (core retrieval)
5. Implement `src/scope.ts` (profile loader, hot-reload, keyword_map inference)
6. Implement `src/dedup.ts` (score filter, source dedup)
7. Implement `src/format.ts` + `index.ts` (hook wiring)
8. Integration test against live Qdrant
9. Deploy: `openclaw plugins install file:~/Developer/shallow-thought`
10. Validate in Marvin session (`debug_log: true`)
11. Roll out to Eddie + Ford

---

## 14. Open Questions

- [ ] Per-source-type score thresholds are in the spec but exact values need calibration against live Qdrant data. Flag as a v0.2 tuning item after baseline results are measured.
- [ ] Token cap uses word-count proxy (×1.3). Good enough for v0.1, but exact tokenization (via tiktoken or model-specific tokenizer) would be more precise. Post-v0.1.
- [ ] Reranking pass before formatting? Would improve precision on ambiguous queries. Post-v0.1.
