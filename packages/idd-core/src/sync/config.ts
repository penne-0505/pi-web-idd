import { readAreas } from "../config/areas.ts";
import type { TrackerSyncConfig } from "./types.ts";

/** the repo's sync settings, or undefined for a repo that is not synced */
export function trackerSyncOf(repo: string): TrackerSyncConfig | undefined {
  return readAreas().trackerSync?.[repo];
}

/** every repo that writes a `tracker_sync` section */
export function trackerSyncRepos(): string[] {
  return Object.keys(readAreas().trackerSync ?? {});
}
