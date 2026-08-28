// intent: DEC-653 — area ごとの慣習は config で吸収し、engine のコードに repo 名を焼き付けない

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AreaConfig {
  context: "meltly" | "personal";
  source_type_priority: "linear" | "github";
  linked_repo: string;
  branch_name_source?: string;
  branch_name_pattern?: string;
  // intent: DEC-670 — worktree を切る元。無い area は下調べに載せない
  local_path?: string;
  upstream_path?: string;
  lanes_root?: string | null;
  intake_filter?: {
    github_labels?: string[];
    linear_labels?: string[];
    linear_statuses?: string[];
  };
}

export interface AreasFile {
  areas: Record<string, AreaConfig>;
}

export function areasPath(): string {
  return process.env.IDD_AREAS_FILE?.trim() || join(process.cwd(), "config", "areas.json");
}

export function readAreas(): AreasFile {
  const path = areasPath();
  if (!existsSync(path)) return { areas: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AreasFile>;
    return { areas: parsed.areas ?? {} };
  } catch {
    return { areas: {} };
  }
}

export function githubAreas(): { area: string; repo: string; labels: string[]; context: string }[] {
  return Object.entries(readAreas().areas)
    .filter(([, cfg]) => cfg.source_type_priority === "github" && cfg.linked_repo)
    .map(([area, cfg]) => ({
      area,
      repo: cfg.linked_repo,
      labels: cfg.intake_filter?.github_labels ?? [],
      context: cfg.context,
    }));
}

export function branchFor(area: string, iddId: string): string {
  const cfg = readAreas().areas[area];
  const pattern = cfg?.branch_name_pattern ?? "idd/{idd_id}";
  return pattern.replace("{idd_id}", iddId);
}
