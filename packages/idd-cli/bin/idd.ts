
import { readFileSync } from "node:fs";
import { raiseOverview } from "../src/init-overview.ts";
import { runLaneCommand, runLaneRedoCommand, runReviewMapCommand, laneUsage, postJsonWithRetry } from "../src/lane-commands.ts";
import { APPROVE_USAGE, runApproveCommand } from "../src/approve.ts";
import { runStorageCommand } from "../src/storage.ts";
import { runForecastCommand } from "../src/forecast.ts";
import { runMetricsCommand } from "../src/metrics.ts";
import { runWorkCommand } from "../src/work.ts";
import { runHoldCommand } from "../src/hold.ts";
import { runOrderCommand } from "../src/order.ts";
import { runProjectCommand } from "../src/project-commands.ts";
import { commandAsksForTick, tickBody } from "../src/tick.ts";
import { requestTick } from "../../idd-lane/src/tick-kick.ts";
import { runGuiBuild } from "../../idd-lane/src/gui-build.ts";
import { formatIntakeList } from "../src/intake-list.ts";
import { runIgnoreCli } from "../src/ignore.ts";
import { readUsage, runReadCommand } from "../src/read-commands.ts";
import { runInit, appendReviewEvent, listReviewLanes, openReviewLane, readReviewLane, reviewLaneLabel, reviewLaneState, agentBaseUrl, runIntake, listIntakeCandidates, parseIssueRef, type IssueRef, prepareSubmit, laneLocations, proposeImport, reviewImport, importUpstream, reclaimLane, cancelImport, syncArea, rerecordFollowups, setLaneBase, adoptLane, validateStackTarget, receiveBase, readBacklog, readAreas, inboxCardUrl, lanesAwaitingShip, buildSubmit, readStandard, runStandardCheck, standardsPath, installSkills, runInstall, runUpgrade, runMigrate, runRepoMigrate } from "../../idd-core/src/index.ts";

const command = process.argv[2] ?? "help";

/** ask for a tick after a command that recorded something; best effort, the command's own result stands */
function kickTick(): void {
  try {
    const kick = requestTick();
    if (kick.outcome === "failed") process.stderr.write(`次の tick を頼めませんでした: ${kick.detail ?? ""}\n`);
  } catch (err) {
    process.stderr.write(`次の tick を頼めませんでした: ${String(err)}\n`);
  }
}

/** a lane id (IDD-12) names a lane; anything else is a branch */
function stackTarget(value: string): { lane?: string; branch?: string } {
  return /^IDD-\d+$/.test(value) ? { lane: value } : { branch: value };
}

/**
 * the value a `--flag VALUE` carries. A next word that is itself a flag is not the value: `--state-dir --pi-bin x`
 * names no state, and must not record `--pi-bin` as one. `undefined` when the flag is absent, `null` when it has none.
 */
function flagValue(args: string[], name: string): string | null | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  return value && !value.startsWith("--") ? value : null;
}

/** hand the package's norms and validator out, and put the package's skills into the user's places */
function runRulesCommand(args: string[]): number {
  const [sub, name] = args;
  if (sub === "path") {
    process.stdout.write(`${standardsPath()}\n`);
    return 0;
  }
  if (sub === "show") {
    if (!name) { process.stderr.write("usage: idd rules show NAME（workflow・records・document_contracts など）\n"); return 2; }
    const found = readStandard(name);
    if (!found) { process.stderr.write(`規約がありません: ${name}\n`); return 1; }
    process.stdout.write(found.body);
    return 0;
  }
  if (sub === "check") return runStandardCheck();
  if (sub === "skills") {
    const res = installSkills();
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ok ? 0 : 1;
  }
  process.stderr.write("usage: idd rules path | show NAME | check | skills\n");
  return 2;
}

async function stackCommand(id: string | undefined, args: string[]): Promise<unknown> {
  if (!id) return { error: "lane（IDD-xxx）を指定してください" };
  if (args.includes("--default")) {
    const area = readBacklog().find((r) => r.idd_id === id)?.area;
    const base = area ? readAreas().areas[area]?.public_base : undefined;
    return base ? setLaneBase(id, { branch: base }, "manual") : { error: "lane か area の public_base がありません" };
  }
  const onAt = args.indexOf("--on");
  const on = flagValue(args, "--on");
  if (onAt < 0 || !on) return { error: "idd stack LANE --on IDD-xxx|BRANCH か --default で指定してください" };
  return setLaneBase(id, stackTarget(on), "manual");
}

async function main(): Promise<number> {
  // `lane redo` is the engine's own verb, not one of idd-lane's lane verbs: it is taken before runLaneCommand,
  // which answers an unknown verb under `lane` with the usage. It asks for its own tick (it does not go through
  // the result branch below).
  const redo = await runLaneRedoCommand(command, process.argv.slice(3));
  if (redo !== undefined) return redo;
  // a person's judgment from the terminal: one card, the content in full, the PIN typed on the terminal. The proof
  // goes to the same decision door the screen uses; nothing leaves this machine from the CLI
  if (command === "approve") return runApproveCommand(process.argv.slice(3));
  if (command === "rules") return runRulesCommand(process.argv.slice(3));
  if (command === "storage") return runStorageCommand(process.argv.slice(3));
  // the start order and the urgent marks: a reader and the move / urgent verbs, all through the engine's door
  if (command === "order") return runOrderCommand(process.argv.slice(3));
  if (command === "forecast") return runForecastCommand(process.argv.slice(3));
  // the period's numbers (Issue #189): read from the engine, printed here; the weekly table is a person's to commit
  if (command === "metrics") return runMetricsCommand(process.argv.slice(3));
  if (command === "work") return runWorkCommand(process.argv.slice(3));
  // what a lane's agent handed over at the boundary (the shim's door, and the lane's own status of it); nothing leaves here
  if (command === "hold") return runHoldCommand(process.argv.slice(3));
  // the Projects of a repo (Issue #234): reads, and writes through the intent door
  if (command === "project") return runProjectCommand(process.argv.slice(3));
  // the reads a person and the conversation's agent share; the same list is the tool's range (C-167-1)
  if (command === "read") {
    const args = process.argv.slice(3);
    if (!args.length) { process.stdout.write(readUsage()); return 2; }
    return runReadCommand(args);
  }
  const laneExit = await runLaneCommand(command, process.argv.slice(3));
  if (laneExit !== undefined) return laneExit;
  // an ignore may have closed a lane: the tick stops what is still running for it and retires its worktree
  const ignored = await runIgnoreCli(command, process.argv.slice(3));
  if (ignored !== undefined) return ignored;
  const [id, argument] = process.argv.slice(3).filter((a) => a !== "--start");
  let result: unknown;
  if (command === "propose") {
    const { readFileSync } = await import("node:fs");
    // only checks (nothing is pushed); moving a lane to the submit card takes --start
    result = await prepareSubmit(id, argument ? JSON.parse(readFileSync(argument, "utf8")) : undefined, { start: process.argv.includes("--start") });
  } else if (command === "export" || command === "ship" || command === "local-complete") {
    // the push, the PR and the landing into the work side's mainline go out only on penne's approval on the inbox
    // card, which shows the commit message (a new PR's title and body too) or the checked merge. Nothing leaves here.
    // The card is named only when the screen would show it: the lane is at the submit stage and its submit view exists.
    const awaiting = id ? lanesAwaitingShip().some((r) => r.idd_id === id) : false;
    const cardId = id && awaiting && buildSubmit(id) ? id : undefined;
    result = {
      ok: false,
      error: command === "local-complete"
        ? "ローカル完了（記録の回収）は、受信箱の提出前確認のカードで承認したときだけ行います。CLI からは行いません"
        : "push と PR の作成は、受信箱の提出前確認のカードで commit message（新しい PR は題名と本文も）を見て承認したときだけ行います。CLI からは行いません",
      url: inboxCardUrl(cardId),
      ...(cardId
        ? { card: cardId }
        : { note: id ? `${id} の提出前確認のカードはまだありません。提出前確認の段になったら、受信箱のカードで承認します` : "受信箱を開きます。承認は、提出前確認のカードで行います" }),
    };
  }
  else if (command === "reclaim") result = reclaimLane(id);
  // the lane's review follow-ups once more, after the cause that stopped them was fixed; nothing leaves the machine
  else if (command === "followups-record") result = id ? await rerecordFollowups(id) : { error: "lane（IDD-xxx）を指定してください" };
  // take the public branch in and close the merged lanes; an agent may run it (no approval, nothing leaves the machine)
  else if (command === "sync") result = id ? await syncArea(id) : { error: "area（owner/name か repos.yaml の name）を指定してください" };
  else if (["receive", "adopt", "review-receive", "accept-receive"].includes(command)) {
    const loc = laneLocations(id);
    if (!loc) result = { error: "lane がありません" };
    else if (command === "adopt" && !argument) result = { error: "採用する公開 branch を指定してください" };
    // the base of the branch's open PR is checked first and recorded once the receive is prepared
    else if (command === "adopt") result = await adoptLane(id, argument);
    else if (command === "receive") result = proposeImport(loc.area, { laneId: id, branch: argument });
    else if (command === "review-receive") result = await reviewImport(loc.area, { laneId: id });
    else result = importUpstream(loc.area, argument, { laneId: id });
  }
  // put a lane on another lane (stacked PR), or back on the area's public base; recorded only, nothing moves
  else if (command === "stack") result = await stackCommand(id, process.argv.slice(4));
  // merge the base's published state into the lane (no approval: nothing leaves the machine; stops on a conflict)
  else if (command === "receive-base") result = id ? await receiveBase(id) : { error: "lane（IDD-xxx）を指定してください" };
  else if (command === "propose-import") result = proposeImport(id);
  else if (command === "cancel-import") result = cancelImport(id);
  else if (command === "cancel-receive") { const loc = laneLocations(id); result = loc ? cancelImport(loc.area, { laneId: id }) : { error: "lane がありません" }; }
  else if (command === "review-import") result = await reviewImport(id);
  else if (command === "import") result = importUpstream(id, argument);
  if (result !== undefined) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const r = result as { ok?: boolean; error?: string };
    const failed = r.ok === false || Boolean(r.error);
    if (!failed && commandAsksForTick(command)) kickTick();
    return failed ? 1 : 0;
  }
  if (command === "intake") {
    const args = process.argv.slice(3);
    // `--unassigned` reads the unassigned Issues a repo does not take in, to be shown apart; it never takes one in
    if (args.includes("--list") || args.includes("-l")) {
      const list = await listIntakeCandidates(args.includes("--unassigned") ? { includeUnassigned: true } : {});
      const { stdout, stderr } = formatIntakeList(list);
      for (const line of stdout) process.stdout.write(`${line}\n`);
      for (const line of stderr) process.stderr.write(`${line}\n`);
      return list.failures.length ? 1 : 0;
    }
    const onAt = args.indexOf("--on");
    const on = flagValue(args, "--on") ?? undefined;
    if (onAt >= 0 && !on) { process.stderr.write("--on には積む先の lane（IDD-xxx）か branch を指定してください\n"); return 2; }
    const tokens = args.filter((a, i) => !a.startsWith("-") && !(onAt >= 0 && i === onAt + 1));
    if (on && !tokens.length) { process.stderr.write("--on は取り込む起票を明示したときだけ使えます\n"); return 2; }
    // the target is checked before anything is taken in, so a wrong --on leaves no lane behind
    const target = on ? validateStackTarget(stackTarget(on)) : {};
    if (target.error) { process.stderr.write(`--on ${on}: ${target.error}\n`); return 2; }
    const refs = tokens.map(parseIssueRef);
    const bad = tokens.filter((_, i) => refs[i] === null);
    if (bad.length) {
      process.stderr.write(`Issue は番号か owner/name#N、Linear の識別子（APP-1234）で指定してください: ${bad.join(" ")}\n`);
      return 2;
    }
    const result = await runIntake(refs.length ? { issueRefs: refs as IssueRef[] } : {});
    let stackFailed = false;
    if (on) {
      const stacked: Record<string, unknown> = {};
      for (const added of result.added) {
        const set = await setLaneBase(added, stackTarget(on), "intake");
        stacked[added] = set;
        if ("error" in set) stackFailed = true;
      }
      Object.assign(result, { stacked });
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (stackFailed) process.stderr.write("取り込んだ lane のうち、積めなかったものがあります（stacked を見て idd stack で指定し直してください）\n");
    if (result.added.length && commandAsksForTick(command)) kickTick();
    return result.failures.length > 0 || stackFailed ? 1 : 0;
  }
  if (command === "install") {
    // prepare this machine: settings, skills, units and the ~/.local/bin/idd wrapper; nothing present is overwritten
    // --state-dir / --pi-bin: where the units and the wrapper point; absent keeps what install.json holds
    const args = process.argv.slice(3);
    const stateDir = flagValue(args, "--state-dir");
    const piBin = flagValue(args, "--pi-bin");
    if (stateDir === null || piBin === null) {
      process.stderr.write(`${stateDir === null ? "--state-dir" : "--pi-bin"} には絶対 path を指定してください\n`);
      return 2;
    }
    const res = runInstall({ ...(stateDir === undefined ? {} : { stateDir }), ...(piBin === undefined ? {} : { piBin }) });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ok ? 0 : 1;
  }
  if (command === "upgrade") {
    // move the installed checkout to a release tag and run the later stages with the new version's own bin.
    // --reinstall is what that new process is told to run (it lays the dependencies and the UI build down again).
    const args = process.argv.slice(3);
    const to = flagValue(args, "--to");
    if (to === null) {
      process.stderr.write("--to には移る先の tag を指定してください\n");
      return 2;
    }
    const res = runUpgrade({ ...(to === undefined ? {} : { to }), here: args.includes("--here"), reinstall: args.includes("--reinstall") });
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ok ? 0 : 1;
  }
  if (command === "migrate") {
    // run the machine-side migrations this machine has not applied, once each
    const res = runMigrate({});
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    return res.ok ? 0 : 1;
  }
  if (command === "repo") {
    const [sub, ...rest] = process.argv.slice(3);
    const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
    if (sub === "init") {
      // a flag that takes a value and is followed by another flag (or nothing) has no value, whether or not the next flag is known; it must not take the next flag's name
      // the check and list flags also refuse an empty value: a check or list that was named but came out empty must stop, not fall back to the unconfirmed detection
      const valued = ["github", "upstream", "work", "public-base", "work-base", "name", "issue-labels", "check", "checks-file", "checks-out", "git-user-name", "git-user-email", "overview", "overview-file", "records"];
      const empty = rest.flatMap((a, i) => a.startsWith("--") && valued.includes(a.slice(2)) && (rest[i + 1] === undefined || (rest[i + 1].startsWith("--") && rest[i + 1].length > 2) || (rest[i + 1].trim() === "" && (a === "--check" || a === "--checks-file" || a === "--checks-out"))) ? [a] : []);
      if (empty.length) { process.stderr.write(`値が要る flag に値がありません: ${empty.join(" ")}\n`); return 2; }
      // bring a project into the upstream / work layout; --dry-run shows the steps and the inventory only
      const github = flag("github"); const upstream = flag("upstream"); const work = flag("work");
      if (!github || !upstream || !work) {
        process.stderr.write("usage: idd repo init --github owner/name --upstream PATH --work PATH [--existing] [--public-base B] [--work-base B] [--name N] [--issue-labels a,b | --no-issue-lane] [--check COMMAND]... [--dry-run --checks-out FILE | --checks-file FILE] [--git-user-name N] [--git-user-email E] [--overview TEXT | --overview-file FILE] [--records keep|drop] [--dry-run]\n");
        return 2;
      }
      const records = flag("records");
      const labels = flag("issue-labels");
      const all = (k: string) => rest.flatMap((a, i) => a === `--${k}` && rest[i + 1] !== undefined ? [rest[i + 1]] : []);
      const overviewFile = flag("overview-file");
      let overview = flag("overview");
      if (overviewFile) {
        try { overview = readFileSync(overviewFile, "utf8"); } catch (err) { process.stderr.write(`--overview-file を読めません: ${String(err)}\n`); return 2; }
      }
      const dryRun = rest.includes("--dry-run");
      // an empty value is no value
      const given = (k: string) => flag(k) || undefined;
      const res = runInit({
        github, upstream, work,
        existing: rest.includes("--existing"),
        dryRun,
        publicBase: given("public-base"),
        workBase: given("work-base"),
        name: given("name"),
        // no flag is the default Issue lane; --no-issue-lane is the explicit choice not to take Issues in
        ...(rest.includes("--no-issue-lane") ? { issueLane: null } : labels ? { issueLane: { labels: labels.split(",").map((l) => l.trim()).filter(Boolean) } } : {}),
        ...(all("check").length ? { checks: all("check") } : {}),
        // the list of checks and setup: --dry-run --checks-out writes it for the user to go over, --checks-file registers exactly that list
        checksFile: given("checks-file"),
        checksOut: given("checks-out"),
        ...(flag("git-user-name") || flag("git-user-email") ? { author: { name: flag("git-user-name"), email: flag("git-user-email") } } : {}),
        ...(overview?.trim() ? { overview } : {}),
        ...(records === "keep" || records === "drop" ? { records } : {}),
      });
      // P-1 needs the registry entry the run just wrote, so it is raised after the run and never on a dry run
      if (res.ok && !dryRun) await raiseOverview(res, github);
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return res.ok ? 0 : 1;
    }
    if (sub === "migrate") {
      // take a fixed template's copies out of a repo, leave it as one clone, and never commit
      const repo = flag("repo");
      if (!repo) { process.stderr.write("usage: idd repo migrate [--repo PATH]\n"); return 2; }
      const res = runRepoMigrate({ repo });
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
      return res.ok ? 0 : 1;
    }
    process.stderr.write("usage: idd repo init --github owner/name --upstream PATH --work PATH [...] | repo migrate [--repo PATH]\n");
    return 2;
  }
  if (command === "review") {
    // review lanes for someone else's PR; posting stays on the outbound card
    const [sub, ...rest] = process.argv.slice(3);
    const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
    if (sub === "open") {
      const repo = flag("repo"); const pr = Number(flag("pr"));
      if (!repo || !pr) { process.stderr.write("usage: idd review open --repo owner/name --pr N\n"); return 2; }
      const rec = openReviewLane({ repo, pr });
      if (commandAsksForTick(command, sub)) kickTick();
      process.stdout.write(`${JSON.stringify({ id: rec.id, repo: rec.repo, pr: rec.pr, next: "次の tick で worktree を用意してレビューを始めます" }, null, 2)}\n`);
      return 0;
    }
    // the map stage alone, outside any lane: for comparing a mapped blind round with the usual one
    if (sub === "map") return runReviewMapCommand(rest);
    if (sub === "list") {
      const rows = listReviewLanes().map((r) => ({ id: r.id, pr: `${r.repo}#${r.pr}`, state: reviewLaneLabel(reviewLaneState(r)) }));
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    if (sub === "show" && rest[0]) {
      const rec = readReviewLane(rest[0]);
      process.stdout.write(`${JSON.stringify(rec ? { ...rec, state: reviewLaneState(rec) } : { error: "ありません" }, null, 2)}\n`);
      return rec ? 0 : 1;
    }
    if ((sub === "resume" || sub === "close") && rest[0]) {
      const rec = readReviewLane(rest[0]);
      if (!rec) { process.stderr.write("review lane がありません\n"); return 1; }
      if (sub === "resume" && reviewLaneState(rec).state !== "stuck") { process.stderr.write("要判断ではありません\n"); return 1; }
      appendReviewEvent(rec.id, sub === "resume" ? "r_resumed" : "r_closed", sub === "close" ? { reason: "penne が閉じた" } : {});
      if (commandAsksForTick(command, sub)) kickTick();
      process.stdout.write(`${JSON.stringify({ id: rec.id, done: sub }, null, 2)}\n`);
      return 0;
    }
    if (sub === "redraft" && rest[0]) {
      const rec = readReviewLane(rest[0]);
      if (!rec) { process.stderr.write("review lane がありません\n"); return 1; }
      const st = reviewLaneState(rec);
      if (st.state !== "awaiting_penne") { process.stderr.write("送出カードの確認待ちではありません\n"); return 1; }
      // recorded before the old card goes, so a tick in between redrafts instead of moving on to the author
      appendReviewEvent(rec.id, "r_redraft_requested", { round: st.round, previous: st.outboundId });
      const res = await fetch(`${agentBaseUrl()}/api/idd/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "outbound_discard", payload: { iddId: st.outboundId } }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!data.ok) { process.stderr.write(`古い送出カード ${st.outboundId} を破棄できませんでした（受信箱で破棄してください）: ${data.error ?? res.status}\n`); return 1; }
      process.stdout.write(`${JSON.stringify({ id: rec.id, done: "redraft", discarded: st.outboundId, next: "次の tick で下書きを作り直します" }, null, 2)}\n`);
      return 0;
    }
    process.stderr.write("usage: idd review open --repo owner/name --pr N | list | show ID | resume ID | redraft ID | close ID | map --wt PATH --base REV --head REV\n");
    return 2;
  }
  if (command === "tick") {
    let body: ReturnType<typeof tickBody>;
    try {
      body = tickBody(process.argv.slice(3));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
    const posted = await postJsonWithRetry(`${agentBaseUrl()}/api/idd/tick`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (posted.error !== undefined) {
      // the engine was being replaced and did not come back in time: the request that remains in the state is picked up at its start
      process.stderr.write(`tick を送れませんでした: ${String(posted.error)}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify(posted.data, null, 2)}\n`);
    return posted.data?.ok ? 0 : 1;
  }
  if (command === "gui-build") {
    // rebuild the screen from the checkout and restart it, or put the earlier build back; run as a transient unit
    const record = await runGuiBuild();
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return record.outcome === "failed" ? 1 : 0;
  }
  process.stdout.write(laneUsage());
  process.stdout.write(`${APPROVE_USAGE}\n`);
  process.stdout.write("usage: idd install [--state-dir PATH] [--pi-bin PATH] | upgrade [--to TAG] [--here] [--reinstall] | migrate | repo init --github owner/name --upstream PATH --work PATH [...] | repo migrate [--repo PATH] | intake [--list [--unassigned]] [N | owner/name#N | APP-1234 ...] [--on IDD-xxx|BRANCH] | ignore REF | unignore REF | ignores | tick [--no-intake] [--for-state DIR] | storage [--json] | order [--json] | order move LANE --to N|--before LANE|--after LANE|--first|--last | order urgent LANE | order unurgent LANE | forecast [IDD-xxx] [--json] | metrics [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json] [--survey] [--out PATH] | gui-build | review open|list|show|resume|close|map | propose LANE [PR_JSON] [--start] | local-complete LANE TOKEN | receive LANE [BRANCH] | adopt LANE BRANCH | stack LANE --on IDD-xxx|BRANCH | stack LANE --default | receive-base LANE | review-receive LANE | accept-receive LANE TOKEN | propose-import AREA | review-import AREA | import AREA TOKEN | reclaim LANE | followups-record LANE | sync AREA | cancel-import AREA | cancel-receive LANE | rules path|show NAME|check|skills | project list|show|new|set|decide|promote|attach|detach|issue-closed|issue-open|complete|cancel|sync | read <command> [args] [--json] | instruction list|proposals|propose|ledger|session\n");
  return command === "help" ? 0 : 2;
}

// the process ends by itself rather than at `process.exit`: bun drops whatever is still queued for stdout at an
// outright exit, and a pipe to another process cut at 65,536 B (a JSON a reader could not parse). Setting the exit
// status lets the queued writes drain first; nothing here starts a handle that would keep the process alive.
main().then((code) => { process.exitCode = code; }).catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exitCode = 1;
});
