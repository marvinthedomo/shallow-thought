# Shallow Thought — Dev Plan

**Based on:** SPEC.md rev 2  
**Created:** 2026-04-13  
**Estimated total:** ~9–10 hours

---

## Dependency Graph

```
config.ts
   ├── embed.ts
   └── scope.ts
          │
          └── search.ts (uses scope profile + embed)
                 │
                 └── dedup.ts
                        │
                        └── format.ts
                               │
                               └── index.ts (hook wiring)
```

Tests are written alongside each module (not after). Integration test requires live Qdrant.

---

## Tasks

### Phase 1 — Scaffold (est. 30 min)

**T1 — Project scaffold**  
- `package.json` with `openclaw` metadata block (`extensions`, `compat`, `build`)  
- `openclaw.plugin.json` manifest (from SPEC §9)  
- `tsconfig.json` (ESM, strict, Node 22 target)  
- Directory structure: `src/`, `config/`, `tests/`  
- `.gitignore`  
- Empty barrel files with `// TODO` stubs  

Output: repo compiles, no logic yet.

---

### Phase 2 — Core types and config (est. 30 min)

**T2 — `src/config.ts`**  
- TypeScript types: `PluginConfig`, `AgentProfile`, `ScoreThresholds`, `KeywordMap`  
- Default values matching SPEC §6 `defaults` block  
- Profile merge: `mergeProfileWithDefaults(partial, globalDefaults) → AgentProfile`  
- Config validation (Zod schema mirroring `openclaw.plugin.json` configSchema)  

No I/O in this module — pure types and merge logic.

---

### Phase 3 — Embedding (est. 45 min)

**T3 — `src/embed.ts`**  
- `embedText(text: string, config: PluginConfig): Promise<number[]>`  
- HTTP POST to `{embedding_url}/api/embeddings` (Ollama native endpoint)  
- Timeout: `embedding_timeout_ms` via `AbortController`  
- On timeout or HTTP error: throw `EmbedError` (caller handles fail_open)  
- Word count helper: `wordCount(text: string): number`  

---

### Phase 4 — Scope and context inference (est. 1 hr)

**T4 — `src/scope.ts`**  
- `loadProfile(agentId: string, config: PluginConfig): Promise<AgentProfile>`  
  - Reads `{profile_dir}/{agentId}.json`  
  - Falls back to global defaults if file missing  
  - Validates schema on load, logs warn on invalid field, falls back to default for that field  
- `watchProfile(agentId: string, config: PluginConfig, onReload: () => void): () => void`  
  - `fs.watchFile` with 1s poll interval  
  - Returns unwatch function  
  - In-memory cache: map of `agentId → { profile, mtime }`  
- `inferLocationFilter(message: string, profile: AgentProfile): string[]`  
  - Scans lowercased message against each location's keyword array in `profile.keyword_map`  
  - Collects matching location names  
  - Intersects with `profile.locations` (if non-empty — otherwise no constraint from profile side)  
  - Returns final location filter array (empty = no location filter applied)  
  - Returns `[]` immediately if `profile.context_inference === false`  

---

### Phase 5 — Qdrant search (est. 1 hr)

**T5 — `src/search.ts`**  
- `searchKnowledge(vector: number[], agentId: string, profile: AgentProfile, locationFilter: string[], config: PluginConfig): Promise<QdrantResult[]>`  
- Builds Qdrant `POST /collections/{collection}/points/search` request:
  - `vector`: query embedding  
  - `limit`: `profile.top_k * 3` (over-fetch before dedup)  
  - `with_payload: true`  
  - `filter`: Qdrant `must` conditions:
    - `source_type IN profile.include_types` (if non-empty)  
    - `source_type NOT IN profile.exclude_types` (if non-empty)  
    - `agent_id IN profile.agent_ids`  
    - `location IN locationFilter` (only if locationFilter non-empty)  
    - `tags HAS ALL profile.tags_require` (if non-empty)  
    - `tags HAS NONE profile.tags_exclude` (if non-empty)  
- Timeout: `qdrant_timeout_ms` via `AbortController`  
- Returns raw Qdrant hits: `{ id, score, payload }`  

---

### Phase 6 — Dedup and score filter (est. 20 min)

**T6 — `src/dedup.ts`**  
- `filterAndDedup(hits: QdrantResult[], profile: AgentProfile): QdrantResult[]`  
  1. Score filter: keep hits where `score >= scoreThresholdFor(hit.payload.source_type, profile.score_thresholds)`  
  2. Group by `hit.payload.source` → keep max-score hit per group  
  3. Sort by score descending  
  4. Take top `profile.top_k`  
- `scoreThresholdFor(sourceType: string, thresholds: ScoreThresholds): number`  
  - Returns `thresholds[sourceType] ?? thresholds.default ?? 0.5`  

---

### Phase 7 — Format (est. 30 min)

**T7 — `src/format.ts`**  
- `formatContextBlock(hits: QdrantResult[], profile: AgentProfile, header: string): string | null`  
  - Returns `null` if hits is empty (no `prependContext` injected)  
  - Builds block: header line + per-chunk attribution comment + text  
  - Attribution format: `<!-- source: {source} | score: {score.toFixed(2)} | type: {source_type} -->`  
  - Token proxy cap: accumulate `estimateTokens(chunk)` = `wordCount × 1.3`, stop adding chunks when cap (`profile.max_tokens`) would be exceeded — include partial last chunk truncated at word boundary  
- `estimateTokens(text: string): number`  

---

### Phase 8 — Plugin entry point (est. 45 min)

**T8 — `index.ts`**  
- `definePluginEntry` with `id: "shallow-thought"`  
- Config schema wired from `src/config.ts`  
- Profile cache initialised at `register()` time  
- `before_prompt_build` hook:
  ```
  1. resolve agentId from ctx
  2. load profile (cached)
  3. check profile.enabled
  4. check wordCount(message) >= profile.min_embed_tokens
  5. embed message  →  catch EmbedError → fail_open return {}
  6. infer location filter
  7. search Qdrant       →  catch SearchError → fail_open return {}
  8. filter + dedup
  9. format
  10. return { prependContext } or {}
  ```  
- `debug_log: true` → `api.logger.debug(...)` each step with timing  
- Graceful shutdown: unwatch all profile watchers on `gateway_stop`  

---

### Phase 9 — Tests (est. 2 hr)

**T9 — Unit tests** (no live services required — mock embed + Qdrant responses)

| File | What to test |
|---|---|
| `tests/config.test.ts` | mergeProfileWithDefaults, schema validation, missing field fallback |
| `tests/embed.test.ts` | wordCount, timeout behaviour (mock AbortController), error propagation |
| `tests/scope.test.ts` | profile load, missing file fallback, inferLocationFilter (all intersection cases), context_inference=false short-circuit |
| `tests/dedup.test.ts` | scoreThresholdFor fallback chain, dedup by source, top_k truncation, empty input |
| `tests/format.test.ts` | empty hits → null, token cap truncation, attribution header format, partial chunk on cap |

**T10 — Integration test** (requires live Qdrant at 127.0.0.1:6333)

| Test | What it verifies |
|---|---|
| `integration: embed roundtrip` | bge-m3 returns 1024-dim vector |
| `integration: search returns results` | query "yarychiv humidifier" returns ha_entity or memory hits |
| `integration: location filter` | query with locationFilter=["yarychiv"] excludes pechersk hits |
| `integration: short message bypass` | 3-word message skips embed, returns {} |
| `integration: fail_open on bad qdrant url` | wrong URL → returns {} without throwing |
| `integration: full pipeline` | before_prompt_build hook returns non-empty prependContext for substantive query |

---

### Phase 10 — Docs and examples (est. 45 min)

**T11 — `config/marvin.json.example`**  
Full example scope profile for Marvin (from SPEC §4A).

**T12 — `config/eddie.json.example`**  
Example scope profile for Eddie.

**T13 — `README.md`**  
- What it does (one paragraph)  
- Install: `openclaw plugins install file:/path/to/shallow-thought`  
- Config: minimal `openclaw.json` snippet  
- Scope profiles: how to create and where to put them  
- Keyword map: example with Ukrainian forms  
- Troubleshooting: `debug_log: true`, checking Qdrant at port 6333  

---

### Phase 11 — Deploy and validate (est. 30 min)

**T14 — Deploy to Marvin**  
1. `openclaw plugins install file:~/.openclaw/workspace/shallow-thought`  
2. `config.patch` to add plugin config to `openclaw.json`  
3. Create `config/shallow-thought/marvin.json` from example  
4. Restart gateway  
5. Send a test message mentioning "yarychiv" with `debug_log: true`  
6. Confirm `prependContext` appears in debug output  
7. Flip `debug_log: false`  

**T15 — Roll out to Eddie and Ford**  
- Create `config/shallow-thought/eddie.json`  
- Create `config/shallow-thought/ford.json`  
- No gateway restart needed (profile hot-reload picks them up)  

---

## Milestone Summary

| Milestone | Tasks | Est. |
|---|---|---|
| M1: Scaffold compiles | T1 | 30 min |
| M2: Core types done | T2 | 30 min |
| M3: Embed + scope working | T3, T4 | 1h 45 min |
| M4: Full retrieval pipeline | T5, T6, T7 | 1h 50 min |
| M5: Plugin hookable | T8 | 45 min |
| M6: Tests passing | T9, T10 | 3h |
| M7: Docs + examples | T11–T13 | 45 min |
| M8: Live in Marvin | T14, T15 | 30 min |
| **Total** | | **~9.5 hr** |

---

## Implementation Order

```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12 → T13 → T14 → T15
```

T3 and T4 can be parallelised (no dependency between embed and scope). Everything else is sequential.

---

## Notes

- TypeScript strict mode throughout. No `any`.
- All Qdrant and Ollama calls use native `fetch` (Node 22 built-in) — no extra HTTP libraries.
- Zod for runtime schema validation of profile files. Already a transitive dep via OpenClaw SDK.
- No bundling for v0.1 — OpenClaw loads TypeScript plugins directly via `tsx`.
