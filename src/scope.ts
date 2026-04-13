import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_PROFILE,
  mergeProfileWithDefaults,
  validateProfileSchema,
} from "./config.js";
import type { AgentProfile, PluginConfig } from "./config.js";

export async function loadProfile(
  agentId: string,
  config: Pick<PluginConfig, "profile_dir" | "defaults">
): Promise<AgentProfile> {
  const filePath = join(config.profile_dir, `${agentId}.json`);

  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isNotFound) {
      console.warn(`[shallow-thought] Could not read profile for ${agentId}:`, err);
    }
    return mergeProfileWithDefaults({});
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.warn(`[shallow-thought] Invalid JSON in profile for ${agentId}:`, err);
    return mergeProfileWithDefaults({});
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.warn(`[shallow-thought] Profile for ${agentId} is not an object, using defaults`);
    return mergeProfileWithDefaults({});
  }

  const partial = parsed as Partial<AgentProfile>;

  try {
    const merged = mergeProfileWithDefaults(partial);
    validateProfileSchema(merged);
    return merged;
  } catch (err: unknown) {
    console.warn(`[shallow-thought] Profile schema validation failed for ${agentId}:`, err);
    return mergeProfileWithDefaults({});
  }
}

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

  // Intersection: if profile.locations is non-empty, only keep locations in that set
  if (profile.locations.length > 0) {
    return matches.filter((loc) => profile.locations.includes(loc));
  }

  return matches;
}
