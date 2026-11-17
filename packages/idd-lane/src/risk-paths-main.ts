/**
 * Print what the registry says about the dangerous paths (`config/repos.yaml` `risk_paths`) of the repo a path belongs
 * to, as one line `scripts/check-docs.sh` reads: `declared <json>` (the JSON the validators read from IDD_RISK_PATHS),
 * `none` (a registered repo with no declaration), `unregistered <reason>` or `broken <reason>`. The check runs this
 * when the harness passed no declaration (a run by hand or on CI), so the validators hold no default dangerous path of
 * their own and still see the repo's own declaration, and a lookup that failed is told apart from a repo without one.
 * On GitHub Actions the run's repository (GITHUB_REPOSITORY) names the repo for a path inside its checkout.
 */
import { riskPathsLookup } from "./repos.ts";

const found = riskPathsLookup(process.argv[2] ?? process.cwd(), {
  ...(process.env.GITHUB_REPOSITORY ? { github: process.env.GITHUB_REPOSITORY } : {}),
  ...(process.env.GITHUB_WORKSPACE ? { workspace: process.env.GITHUB_WORKSPACE } : {}),
});
const line = found.kind === "declared" ? `declared ${found.value}` : found.kind === "none" ? "none" : `${found.kind} ${found.reason.replace(/\s+/g, " ")}`;
process.stdout.write(`${line}\n`);
