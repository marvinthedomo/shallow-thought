# Shallow Thought — Plugin Specification

**Package:** `openclaw-shallow-thought`  
**Repo:** https://github.com/marvinthedomo/shallow-thought  
**Version:** 0.1.0  
**Status:** Draft — 2026-04-13

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
1. Embed user message → bge-m3 via Ollama
       │
       ▼
2. Build Qdrant filter (scope profile + context inference)
       │
       ├─── Scope profile (from agent config file, hot-reloadable)
       │    e.g. { include_types: ["ha_entity", "automation"], locations: ["yarychiv"] }
       │
       └─── Context inference (from message content)
            e.g. "yarychiv" detected → add yarychiv location filter
                 "pechersk" detected → add pechersk location filter
       │
       ▼
3. Search Qdrant (dense vector similarity + payload filter)
       │
       ▼
4. Score filter + dedup
       │
       ▼
5. Format context block
       │
       ▼
6. Return { prependContext: "..." }
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

Payload field values for `source_type`:
- `memory` — daily/location notes from `memory/`
- `skill` — skill SKILL.md files
- `script` — automation scripts
- `ha_entity` — Home Assistant entity registry
- `ha_automation` — Home Assistant automations
- `experience` — distilled knowledge from `experience_distiller.py`
- `config` — system config context

Payload field values for `agent_id`:
- `*` — shared across all agents
- `marvin`, `eddie`, `ford`, etc. — agent-specific knowledge

---

## 4. Scope System

### 4A — Scope Profiles (hot-reloadable config files)

Each agent has an optional scope profile at:
```
~/.openclaw/workspace/config/shallow-thought/<agent_id>.json
```

Example for Marvin:
```json
{
  "enabled": true,
  "top_k": 6,
  "score_threshold": 0.5,
  "include_types": ["memory", "ha_entity", "ha_automation", "experience", "skill"],
  "exclude_types": [],
  "locations": [],
  "agent_ids": ["*", "marvin"],
  "tags_require": [],
  "tags_exclude": []
}
```

Example for Eddie (task-focused, no HA noise):
```json
{
  "enabled": true,
  "top_k": 4,
  "score_threshold": 0.55,
  "include_types": ["memory", "experience"],
  "exclude_types": ["ha_entity", "ha_automation"],
  "locations": [],
  "agent_ids": ["*", "eddie"]
}
```

**Profile fields:**

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Enable/disable injection for this agent |
| `top_k` | int | `5` | Max chunks to inject |
| `score_threshold` | float | `0.5` | Minimum similarity score (0-1) |
| `include_types` | string[] | `[]` (all) | Only include these source_types |
| `exclude_types` | string[] | `[]` | Exclude these source_types |
| `locations` | string[] | `[]` (all) | Only include these locations |
| `agent_ids` | string[] | `["*"]` | Only include knowledge for these agents |
| `tags_require` | string[] | `[]` | Chunks must have ALL these tags |
| `tags_exclude` | string[] | `[]` | Chunks must not have ANY of these tags |

**Hot-reload:** Plugin uses `fs.watchFile` on each profile path. Changes take effect within 1s, no restart required.

**Fallback:** If no profile file exists for an agent, fall back to global defaults defined in `plugins.entries.shallow-thought.config` in `openclaw.json`.

### 4B — Context Inference (automatic, per-turn)

The plugin inspects the user's message text and dynamically narrows the Qdrant filter:

| Signal detected in message | Filter added |
|---|---|
| `yarychiv`, `яричів`, `village`, `selo` | `location = "yarychiv"` |
| `pechersk`, `печерськ`, `kyiv`, `київ` | `location = "pechersk"` |
| `eddie`, `task`, `reminder`, `завдання` | `source_type IN ["memory", "experience"]` priority boost |
| No location signals | No location filter — all locations included |

Context inference is additive: it can only narrow (add filters), never override the profile's `locations` setting if it is already set.

---

## 5. Plugin Config (openclaw.json)

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
          "default_top_k": 5,
          "default_score_threshold": 0.5,
          "profile_dir": "~/.openclaw/workspace/config/shallow-thought",
          "context_block_header": "## Retrieved Knowledge",
          "fail_open": true,
          "debug_log": false
        }
      }
    }
  }
}
```

**Config fields:**

| Field | Type | Description |
|---|---|---|
| `qdrant_url` | string | Qdrant REST API base URL |
| `collection` | string | Qdrant collection name |
| `embedding_url` | string | Ollama base URL for embeddings |
| `embedding_model` | string | Ollama model name for embedding |
| `embedding_timeout_ms` | int | Max wait for embedding call (ms) |
| `qdrant_timeout_ms` | int | Max wait for Qdrant search (ms) |
| `default_top_k` | int | Default top-K if no profile |
| `default_score_threshold` | float | Default score threshold if no profile |
| `profile_dir` | string | Directory for agent scope profiles |
| `context_block_header` | string | Header text for the injected block |
| `fail_open` | bool | If true, proceed without context on error (never block the agent) |
| `debug_log` | bool | Log injection details to gateway log |

---

## 6. Output Format

The injected `prependContext` block:

```
## Retrieved Knowledge
<!-- source: memory/yarychiv.md | score: 0.81 -->
H700 humidifier at Yarychiv was turned off 2026-04-13. Re-enable automations April 17 at 10:00.

<!-- source: ha_entity:climate.yarychiv_living_room | score: 0.74 -->
Entity: climate.yarychiv_living_room | current_temp: 21°C | hvac_mode: off

<!-- source: memory/2026-04-12.md | score: 0.67 -->
Solar curtailment threshold for Yarychiv is 240V grid voltage.
```

Rules:
- Max `top_k` chunks (default 5, configurable per agent)
- Ordered by score descending
- Each chunk: HTML comment header with source + score, then raw text
- Total block capped at 2,000 tokens (truncate last chunk if needed)
- Empty block → no `prependContext` returned (no noise)

---

## 7. Hook Registration

```typescript
register(api) {
  api.registerHook("before_prompt_build", async (ctx) => {
    const context = await buildContext(ctx, pluginConfig);
    if (!context) return {};
    return { prependContext: context };
  });
}
```

- Uses `before_prompt_build` (not deprecated `before_agent_start`)
- Returns `{}` on error if `fail_open: true` (agent continues without injection)
- Throws on error if `fail_open: false` (hard block — not recommended for prod)

---

## 8. Performance Budget

| Step | Target | Hard limit |
|---|---|---|
| Embedding call (bge-m3) | < 200ms | 3,000ms |
| Qdrant search | < 50ms | 2,000ms |
| Total hook overhead | < 300ms | 5,000ms |

If embedding or search exceeds their hard limit, the hook returns `{}` immediately (fail-open). The agent call is never blocked by RAG latency.

---

## 9. Non-Goals (v0.1)

- No write path — this plugin only reads from Qdrant. Indexing stays in `rag_indexer.py`.
- No per-turn memory capture (that's `memory-lancedb` territory, may be addressed later).
- No UI or admin panel.
- No cloud deployment — local Qdrant only for now.
- No hybrid search (sparse + dense) — pure dense for v0.1, can add later.

---

## 10. File Layout

```
shallow-thought/
  package.json
  openclaw.plugin.json
  tsconfig.json
  index.ts              # Plugin entry point
  src/
    embed.ts            # bge-m3 embedding via Ollama
    search.ts           # Qdrant search with filter building
    scope.ts            # Profile loader + hot-reload + context inference
    format.ts           # Context block formatter
    config.ts           # Config schema + defaults
  config/
    marvin.json.example # Example scope profile
    eddie.json.example  # Example scope profile
  tests/
    embed.test.ts
    search.test.ts
    scope.test.ts
    format.test.ts
    integration.test.ts
  SPEC.md               # This file
  README.md
```

---

## 11. Rollout Plan

1. Write spec (this document) → land in repo ✅
2. Dev plan — task breakdown with estimates
3. Test cases — written before implementation
4. Implement `src/embed.ts` + `src/search.ts` (core retrieval)
5. Implement `src/scope.ts` (profile + inference)
6. Implement `src/format.ts` + `index.ts` (hook wiring)
7. Integration test against live Qdrant
8. Deploy: `openclaw plugins install file:~/Developer/shallow-thought`
9. Validate injection in Marvin session (debug_log: true)
10. Roll out to Eddie + Ford

---

## 12. Open Questions

- [ ] Should context inference be configurable (enable/disable per agent)?
- [ ] Token cap: 2,000 tokens per turn — is that the right budget? Check typical prompt size.
- [ ] Should scores be shown to the agent (they're in the HTML comments so invisible to LLM) — is that right?
- [ ] Reranking: add a lightweight reranker pass before formatting? (Post-v0.1)
