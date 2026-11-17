import { createLinearClient, readLinearKey, type LinearClient } from "../intake/linear.ts";
import type { TrackerReader } from "./reader.ts";
import type { ExtIssue, ExtProject, ExtSnapshot } from "./types.ts";

/**
 * Linear as the outside, read through the intake's client: the key, the fixed query documents and the scrubbing of what
 * a failure says all stay in `intake/linear.ts`, and this file hands it nothing but a team key, a Project id and an
 * identifier.
 */

/** the client, or throws with the reason when there is no key; a test hands one in */
function clientOrThrow(client?: LinearClient): LinearClient {
  if (client) return client;
  const read = readLinearKey();
  if (read.key === null) throw new Error(read.reason);
  return createLinearClient(read.key);
}

export function createLinearReader(team: string, client?: LinearClient): TrackerReader {
  const teamKey = team.toUpperCase();
  const owns = (ref: string): boolean => new RegExp(`^${teamKey}-\\d+$`, "i").test(ref);
  return {
    tracker: "linear",
    owns,

    async read(refs): Promise<ExtSnapshot> {
      const linear = clientOrThrow(client);
      const listed = await linear.listTeamProjects({ team: teamKey });
      const projects: ExtProject[] = listed.projects.map((p) => ({ id: p.id, name: p.name, body: p.description, ...(p.url ? { url: p.url } : {}) }));
      const issues = new Map<string, ExtIssue>();
      let truncated = listed.truncated;
      for (const p of projects) {
        const got = await linear.listProjectIssues({ project: p.id });
        if (got.truncated) truncated = true;
        for (const i of got.issues) if (owns(i.identifier)) issues.set(i.identifier, { ref: i.identifier, closed: i.closed, projectId: i.projectId });
      }
      // an Issue propter's Projects hold that no listed Project holds is read by its own name: its state and its (lack of a) Project still count
      // (null is Linear's answer "no such Issue"; a failed read is unread, never a reason to call the Issue gone)
      const unread: string[] = [];
      for (const ref of refs) {
        const name = ref.toUpperCase();
        if (issues.has(name) || !owns(name)) continue;
        try {
          const one = await linear.getSyncIssue(name);
          if (one) issues.set(one.identifier, { ref: one.identifier, closed: one.closed, projectId: one.projectId });
        } catch {
          unread.push(ref);
        }
      }
      return { projects, issues: [...issues.values()], truncated, projectsTruncated: listed.truncated, ...(unread.length ? { unread } : {}) };
    },
  };
}
