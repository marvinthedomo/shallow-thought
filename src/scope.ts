import * as fs from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  mergeProfileWithDefaults,
  validateProfileSchema,
  expandTilde,
} from "./config.js";
import type { AgentProfile, PluginConfig, PluginConfigDefaults } from "./config.js";

// ---------------------------------------------------------------------------
// In-memory profile cache — keyed by absolute file path
// ---------------------------------------------------------------------------

interface CacheEntry {
  profile: AgentProfile;
  mtime: number;
}

const profileCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// loadProfile
// ---------------------------------------------------------------------------

export async function loadProfile(
  agentId: string,
  config: Pick<PluginConfig, "profile_dir" | "defaults">
): Promise<AgentProfile> {
  const filePath = join(expandTilde(config.profile_dir), `${agentId}.json`);
  const gatewayDefaults: Partial<PluginConfigDefaults> = config.defaults;

  // Check if file exists and get its mtime
  let mtime: number;
  try {
    const stat = fs.statSync(filePath);
    mtime = stat.mtimeMs;
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.warn(`[shallow-thought] Could not stat profile for ${agentId}:`, err);
    }
    // File doesn't exist — return defaults, nothing to cache
    return mergeProfileWithDefaults({}, gatewayDefaults);
  }

  // Cache hit: same file, same mtime
  const cached = profileCache.get(filePath);
  if (cached !== undefined && cached.mtime === mtime) {
    return cached.profile;
  }

  // Cache miss or stale — read and parse
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    console.warn(`[shallow-thought] Could not read profile for ${agentId}:`, err);
    return mergeProfileWithDefaults({}, gatewayDefaults);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.warn(`[shallow-thought] Invalid JSON in profile for ${agentId}:`, err);
    return mergeProfileWithDefaults({}, gatewayDefaults);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[shallow-thought] Profile for ${agentId} is not an object, using defaults`);
    return mergeProfileWithDefaults({}, gatewayDefaults);
  }

  const partial = parsed as Partial<AgentProfile>;

  let profile: AgentProfile;
  try {
    const merged = mergeProfileWithDefaults(partial, gatewayDefaults);
    validateProfileSchema(merged);
    profile = merged;
  } catch (err: unknown) {
    console.warn(`[shallow-thought] Profile schema validation failed for ${agentId}:`, err);
    return mergeProfileWithDefaults({}, gatewayDefaults);
  }

  // Store in cache
  profileCache.set(filePath, { profile, mtime });
  return profile;
}

// ---------------------------------------------------------------------------
// watchProfile — hot-reload via fs.watchFile
// ---------------------------------------------------------------------------

export function watchProfile(
  agentId: string,
  config: Pick<PluginConfig, "profile_dir">,
  onReload?: () => void
): () => void {
  const filePath = join(expandTilde(config.profile_dir), `${agentId}.json`);

  fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      profileCache.delete(filePath);
      onReload?.();
    }
  });

  return () => fs.unwatchFile(filePath);
}

// ---------------------------------------------------------------------------
// inferLocationFilter
// ---------------------------------------------------------------------------

export function inferLocationFilter(
  message: string,
  profile: AgentProfile
): string[] {
  if (!profile.context_inference) return [];

  const keys = Object.keys(profile.keyword_map);
  if (keys.length === 0) return [];

  const lower = message.toLowerCase();
  const matches: string[] = [];

  for (const location of keys) {
    const keywords = profile.keyword_map[location] ?? [];
    const matched = keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (matched) {
      matches.push(location);
    }
  }

  // Intersection: profile.locations defines the allowed set; inference picks within it
  if (profile.locations.length > 0) {
    return matches.filter((loc) => profile.locations.includes(loc));
  }

  return matches;
}
