// Lightweight smoke checks for agent workflow activation surfaces.

// 未初期化 template では利用者向けファイルが starter/ に畳まれている。展開後は
// root へ戻るため、どちらの状態でも同じ検査が成立するよう実在するほうを読む。
// starter/ を先に見るのは、未初期化 template の root には利用者向け AGENTS.md では
// なく router が置かれているため。root を先に読むと router を検査してしまう。
const shipped = async (path: string): Promise<string> => {
  try {
    return await Deno.readTextFile(`starter/${path}`);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
    return await Deno.readTextFile(path);
  }
};

const read = (path: string): Promise<string> => shipped(path);

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    console.error(`FAIL ${message}`);
    Deno.exit(1);
  }
  console.log(`PASS ${message}`);
};

const json = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await read(path)) as Record<string, unknown>;

const contains = (text: string, ...needles: string[]): boolean =>
  needles.every((needle) => text.includes(needle));

type HookConfig = {
  hooks?: Record<string, unknown>;
};

const codexHooks = await json(".codex/hooks.json") as HookConfig;
const claudeSettings = await json(".claude/settings.json") as HookConfig;
const agentHook = await read("scripts/agent-workflow-hook.ts");
const agentsInventory = await read(".agents/skills/docs-inventory/SKILL.md");
const claudeInventory = await read(".claude/skills/docs-inventory/SKILL.md");
const agentsMigration = await read(
  ".agents/skills/docs-template-migration/SKILL.md",
);
const claudeMigration = await read(
  ".claude/skills/docs-template-migration/SKILL.md",
);
const agentsClose = await read(".agents/skills/close/SKILL.md");
const claudeClose = await read(".claude/skills/close/SKILL.md");
const agentsGuide = await read("AGENTS.md");
const quickstart = await read("QUICKSTART.md");
const documentationOperations = await read(
  "_docs/standards/template_operations.md",
);
const templateLockExample = await json("docs-template.lock.example.json") as {
  schema?: number;
  source?: string;
  revision?: { tag?: string; commit?: string };
};
const intentTemplate = await read("_docs/standards/templates/intent.md");
const qaTemplate = await read("_docs/standards/templates/qa.md");
const qualityStandard = await read("_docs/standards/workflow.md");
const whyFirstSkills = [
  "prep",
  "close",
  "intent-mining",
] as const;
const agentsMining = await read(".agents/skills/intent-mining/SKILL.md");

const hookEvents = (config: HookConfig): string[] =>
  Object.keys(config.hooks ?? {});

assert(
  ["SessionStart", "PreToolUse", "Stop"].every((event) =>
    hookEvents(codexHooks).includes(event)
  ) && !hookEvents(codexHooks).includes("UserPromptSubmit"),
  "Codex hooks include SessionStart, PreToolUse, Stop and drop the per-prompt injection",
);

assert(
  ["SessionStart", "PreToolUse", "Stop"].every((event) =>
    hookEvents(claudeSettings).includes(event)
  ) && !hookEvents(claudeSettings).includes("UserPromptSubmit"),
  "Claude hooks include SessionStart, PreToolUse, Stop and drop the per-prompt injection",
);

assert(
  JSON.stringify(codexHooks).includes("scripts/agent-workflow-hook.ts") &&
    JSON.stringify(claudeSettings).includes("scripts/agent-workflow-hook.ts"),
  "hook configs call the shared workflow hook script",
);

assert(
  JSON.stringify(codexHooks).includes(
    "--allow-read --allow-env --allow-run=git scripts/agent-workflow-hook.ts",
  ) &&
    JSON.stringify(claudeSettings).includes(
      "--allow-read --allow-env --allow-run=git scripts/agent-workflow-hook.ts",
    ),
  "hook configs declare --allow-env for Stop git env sanitization",
);

assert(
  contains(agentHook, "prep", "close", "docs-inventory"),
  "workflow hook maps the four skills onto the work phases",
);

assert(
  contains(agentHook, "close skill", "close で処理"),
  "stop reminder points at the close skill as the handler",
);

assert(
  contains(
    agentHook,
    "無視して",
    "作業を始めないでください",
    "本筋の次の指示",
  ) && !contains(agentHook, "counterevidence"),
  "stop reminder is ignorable, defers work, and drops keyword-compliance audits",
);

assert(
  agentsInventory === claudeInventory,
  "docs-inventory skill is synced across .agents and .claude",
);

assert(
  agentsMigration === claudeMigration,
  "docs-template-migration skill is synced across .agents and .claude",
);

for (const skill of whyFirstSkills) {
  assert(
    await read(`.agents/skills/${skill}/SKILL.md`) ===
      await read(`.claude/skills/${skill}/SKILL.md`),
    `${skill} skill is synced across .agents and .claude`,
  );
}

assert(
  contains(agentsInventory, "read-only", "stale documentation audit"),
  "docs-inventory remains a read-only stale-doc audit entrypoint",
);

assert(
  contains(
    agentsMigration,
    "three-way migration",
    "recommended upstream release tag",
    "full commit SHA",
    "docs-template.lock.json",
    "Legacy bootstrap for pre-v1.0.0 repositories",
    "directly to any selected release `U >= v1.0.0`",
    "does not need an intermediate",
    "premature lock",
    "advancement",
    "bulk schema edits",
    "Completion criterion",
  ),
  "docs-template-migration preserves provenance, legacy bootstrap, and staged schema boundaries",
);

const migrationSteps = agentsMigration
  .split(/^### \d+\..*$/m)
  .slice(1);
assert(
  migrationSteps.length === 6 &&
    migrationSteps.every((step) => step.includes("Completion criterion:")),
  "every docs-template-migration step has a completion criterion",
);

assert(
  templateLockExample.schema === 1 &&
    templateLockExample.source ===
      "https://github.com/penne-0505/intent_driven_dev_template.git" &&
    templateLockExample.revision?.tag === "v2.5.3" &&
    templateLockExample.revision?.commit ===
      "REPLACE_WITH_THE_TAGS_FULL_40_CHARACTER_COMMIT_SHA",
  "template lock example identifies the v2.5.3 release and full-SHA placeholder",
);

assert(
  contains(
    quickstart,
    "Template の継続更新",
    "`v1.0.0` より前",
    "任意の推奨 tag へ直接移行",
    "`DD_SCOPE_BASE` は導入先 repository 内",
  ) &&
    contains(
      documentationOperations,
      "Template revision provenance",
      "compatibility checks",
      "closure verification",
      "strict schema migration",
      "pre-v1.0.0 bootstrap",
    ),
  "reader docs separate template provenance, legacy bootstrap, and validator scope",
);

assert(
  contains(agentsClose, "Archive the Plan", "Never archive intent"),
  "close skill keeps archive boundary guidance",
);

assert(
  contains(
    agentsMining,
    "Evidence over invention",
    "A guess is a question, not a record",
    "Incremental by default",
    "Reporting boundary",
  ),
  "intent-mining skill grounds mined DECs in evidence and staged scope",
);

assert(
  contains(
    agentsGuide,
    "docs-inventory",
    "docs-template-migration",
    "release tag",
    "docs-template.lock.json",
    "`prep` skill",
    "`close` skill",
    "// intent: DEC-00X",
    "// intent-invariant: INV-00X",
  ),
  "AGENTS.md exposes workflow entrypoints and targeted intent anchors",
);

assert(
  contains(
    intentTemplate,
    "intent_schema: 3",
    "### DEC-XXX:",
    "**Why**:",
    "**Change freedom**:",
    "リポジトリ全体で一意",
  ),
  "intent template requires why-first DEC records with repo-unique IDs",
);

assert(
  contains(
    qaTemplate,
    "qa_schema: 5",
    "## Acceptance Criteria",
    "## Checks",
    "## Rounds",
    "Intent Delta",
    "None:",
  ),
  "unified QA template carries checks, rounds, and intent delta",
);

assert(
  !contains(agentsClose, "(candidate)", "Transferable Principles"),
  "close skill no longer carries the transferable-principle reflection duty",
);

assert(
  contains(
    qualityStandard,
    "INV が 0 件でも正常",
    "exact 値を固定するテスト",
  ),
  "quality standard keeps invariants optional and rejects accidental value locks",
);
