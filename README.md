# shallow-thought

OpenClaw plugin — Qdrant-backed RAG knowledge injection for AI agents.

Automatically retrieves relevant knowledge from a Qdrant vector database and prepends it to agent context before each LLM call. Uses the `before_prompt_build` hook. Named after the inverse of Deep Thought — fast, practical answers rather than 7.5 million years of deliberation.

## How it works

The plugin follows a 5-step pipeline for every agent turn:
1. **Embed**: The user's message is converted into a vector using `bge-m3` via Ollama.
2. **Filter**: A Qdrant filter is built based on the agent's scope profile (agent IDs, tags, and inferred location).
3. **Search**: A dense vector search is performed in Qdrant to find the most similar knowledge chunks.
4. **Dedup**: Results are deduplicated by source, keeping only the highest-scoring chunk per document.
5. **Inject**: The final set of chunks is formatted and prepended to the agent's prompt.

This process is transparent to the agent; the model receives the knowledge with source attribution, allowing it to cite its sources.

## Prerequisites

- **Qdrant**: Running locally (typically via Docker) on port 6333.
- **Ollama**: Installed and running with the `bge-m3` embedding model pulled.
- **OpenClaw**: Version ≥ 2026.3.24.

## Install

```bash
openclaw plugins install file:/path/to/shallow-thought
```

## Config (openclaw.json)

Add the following to your `openclaw.json`. Most fields have sensible defaults.

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
          "profile_dir": "~/.openclaw/workspace/config/shallow-thought"
        }
      }
    }
  }
}
```

## Scope profiles

Each agent can have a custom scope profile at `{profile_dir}/{agentId}.json`. These profiles are hot-reloaded; changes take effect within 1 second without requiring a gateway restart.

### Profile Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | bool | `true` | Enable/disable injection for this agent |
| `top_k` | int | `5` | Max chunks to inject after dedup |
| `max_tokens` | int | `2000` | Token cap for the entire injected block |
| `min_embed_tokens` | int | `5` | Skip embedding if message word count < this |
| `include_types` | string[] | `[]` (all) | Only include these `source_type` values |
| `exclude_types` | string[] | `[]` | Exclude these `source_type` values |
| `locations` | string[] | `[]` (all) | Allowed location set for inference |
| `agent_ids` | string[] | `["*"]` | Only include vectors with these `agent_id` values |
| `tags_require` | string[] | `[]` | Chunks must have ALL these tags |
| `tags_exclude` | string[] | `[]` | Chunks must not have ANY of these tags |
| `score_thresholds` | object | `{default: 0.5}` | Per-`source_type` score cutoffs |
| `keyword_map` | object | `{}` | Maps location names to keyword arrays |
| `context_inference` | bool | `true` | Enable keyword-based location inference |

## Keyword map

The `keyword_map` allows the plugin to automatically narrow the search to a specific location if the user mentions it.

**Example:**
```json
"keyword_map": {
  "yarychiv": ["yarychiv", "яричів", "яричеві", "village", "село"],
  "pechersk": ["pechersk", "печерськ", "kyiv", "київ"]
}
```

Matching is case-insensitive substring search. The `profile.locations` field acts as a constraint; if a location is inferred but not present in the `locations` array, it will be ignored.

## Context injection format

Knowledge is injected as a block at the start of the prompt. The model sees the source, score, and type, which it can use for citations.

**Example output:**
```
## Retrieved Knowledge
<!-- source: memory/yarychiv.md | score: 0.81 | type: memory -->
H700 humidifier at Yarychiv was turned off 2026-04-13.

<!-- source: ha_entity:climate.yarychiv_living_room | score: 0.74 | type: ha_entity -->
Entity: climate.yarychiv_living_room | current_temp: 21°C
```

## Troubleshooting

- **Debug Logs**: Enable `debug_log: true` in the plugin config to see per-step timing and filter details in the gateway logs.
- **Qdrant Connectivity**: Verify the collection exists:
  `curl http://127.0.0.1:6333/collections/knowledge`
- **Embedding Model**: Ensure `bge-m3` is available in Ollama:
  `ollama list | grep bge-m3`

## Development

- **Unit Tests**: `npm test`
- **Integration Tests**: `SHALLOW_THOUGHT_INTEGRATION=1 npm run test:integration`

## Schema notes

The current indexer (`rag_indexer.py`) uses the `type` field rather than `source_type`. Location filtering requires re-indexing with the `location` field. The plugin is designed to handle both schemas for compatibility.
