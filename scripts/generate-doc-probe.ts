// Doc probe generator: 展開済み複製に「実在する運用文書一式」を生成し、walk 型
// validator を実文書に対して発火させる。テンプレ repo 自身は meta-work 例外で
// _docs/intent・_docs/qa が空のため、これが無いと validator は一度も実文書を
// 検査せずに CI が green になる (v2.3.1 / v2.3.2 の両バグの共通根本原因)。
// 未初期化 template (starter/ が存在) では実行を拒否し、meta-work 汚染を防ぐ。

const die = (message: string): never => {
  console.error(`generate-doc-probe: ${message}`);
  Deno.exit(1);
};

try {
  const stat = await Deno.stat("starter");
  if (stat.isDirectory) {
    die(
      "starter/ exists — the probe must run in an expanded copy, never in the template repo itself",
    );
  }
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) throw err;
}

const today = new Date().toISOString().slice(0, 10);
const AREA = "Probe";
const SLUG = "doc-probe";
const DEC_ID = "DEC-950";

const intentDoc = `---
title: Probe decision
status: active
intent_schema: 3
created_at: ${today}
updated_at: ${today}
references:
  - "_docs/qa/${AREA}/${SLUG}/qa.md"
related_issues: []
related_prs: []
---

## Context
- CI probe: exercises the current intent schema against the real validators.

## Decisions

### ${DEC_ID}: Validators must be exercised against real documents

- **What**: CI generates a sample document set in the expanded copy and runs every validator against it.
- **Why**: the template repo ships empty _docs trees, so walk-based validators can pass without ever reading a real document; schema drift then surfaces only in adopter projects.
- **Change freedom**: the probe's content and location may change as long as every walk-based validator reads at least one current-schema document in CI.

## Consequences / Impact
- CI fails when a validator rejects the schemas the standards prescribe.

## Quality Implications
- Guards against claims-vs-implementation drift between standards and validators.

## Intent-derived Invariants
None

## Rollback / Follow-ups
- None.
`;

const qaDoc = `---
title: "QA: Doc probe"
status: active
qa_status: verified
risk: Medium
qa_schema: 5
created_at: ${today}
updated_at: ${today}
references:
  - "_docs/intent/${AREA}/${SLUG}/decision.md"
related_issues: []
related_prs: []
---

# QA: Doc probe

## Acceptance Criteria

- AC-001: every walk-based validator accepts a current-schema document set.

## Checks

| ID | Source | Requirement / Invariant | Check Type | Command / File | Status |
| --- | --- | --- | --- | --- | --- |
| AC-001 | TODO | validators accept current schemas | validator | ./scripts/check-docs.sh | verified |

## Rounds

### Round 1 (${today})

- **Commands**:

  \`\`\`bash
  ./scripts/check-docs.sh
  \`\`\`

- **AC Coverage**: AC-001 verified
- **Intent Delta**: applied: ${DEC_ID}
- **R2**: 非発動
- **Verdict**: PASS
`;

const maintenanceDoc = `---
title: "QA rounds: ${AREA} maintenance"
status: active
qa_status: in-progress
risk: Low
qa_schema: 5
created_at: ${today}
updated_at: ${today}
references: []
related_issues: []
related_prs: []
---

# QA rounds: ${AREA} maintenance

## Rounds

### Round 1 (${today})

- **Commands**:

  \`\`\`bash
  ./scripts/check-docs.sh
  \`\`\`

- **AC Coverage**: AC-001 covered
- **Intent Delta**: None: probe round with no decision-bearing branch
- **R2**: 非発動
- **Verdict**: PASS
`;

const write = async (path: string, content: string): Promise<void> => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, content);
  console.log(`wrote ${path}`);
};

await write(`_docs/intent/${AREA}/${SLUG}/decision.md`, intentDoc);
await write(`_docs/qa/${AREA}/${SLUG}/qa.md`, qaDoc);
await write(`_docs/qa/${AREA}/maintenance.md`, maintenanceDoc);

// TODO.md にも probe タスクを追加し、validate-todo と validate-qa の TODO 整合
// 検査 (QA path・risk 一致・references の Intent 包含) を実文書で発火させる。
const todoPath = "TODO.md";
let todo: string;
try {
  todo = await Deno.readTextFile(todoPath);
} catch {
  die("TODO.md not found — run inside an expanded copy");
  throw new Error("unreachable");
}

const nextIdMatch = todo.match(/Next ID No:\s*(\d+)/);
if (!nextIdMatch) die("TODO.md has no Next ID No line");
const nextId = Number(nextIdMatch![1]);

const probeTask =
  `### ${AREA}-Chore-${nextId}: [Chore] Exercise validators with the doc probe

- **Title**: [Chore] Exercise validators with the doc probe
- **ID**: ${AREA}-Chore-${nextId}
- **Priority**: P3
- **Size**: XS
- **Risk**: Medium
- **Area**: ${AREA}
- **Dependencies**: []
- **Goal**: CI が現行 schema の実文書一式で全 validator を発火させている。
- **Acceptance Criteria**:
  - AC-001: 生成された probe 文書一式で ./scripts/check-docs.sh が pass する。
  - AC-002: TODO 整合検査 (QA path / risk / references) が実文書で発火している。
- **Steps**:
  1. [ ] CI の starter-expansion job が probe を実行する
- **Description**:
  - Context: walk 型 validator の空回り (v2.3.1 / v2.3.2 の根本原因) への恒久対策。
  - Notes: この task は probe 生成物であり、実プロジェクトの Backlog には現れない。
- **Plan**: None
- **Intent**: _docs/intent/${AREA}/${SLUG}/decision.md
- **QA**: _docs/qa/${AREA}/${SLUG}/qa.md
`;

todo = todo.replace(/Next ID No:\s*\d+/, `Next ID No: ${nextId + 1}`);
const backlogAnchor = "\n---\n\n## Ready";
if (!todo.includes(backlogAnchor)) die("TODO.md has no Backlog/Ready boundary");
todo = todo.replace(backlogAnchor, `\n${probeTask}${backlogAnchor}`);
await Deno.writeTextFile(todoPath, todo);
console.log("appended probe task to TODO.md");
