const validator =
  new URL("./validate-intent-delta.ts", import.meta.url).pathname;

// the caller's comparison base, git location and repo declaration (check-docs run with DD_DELTA_BASE, or from a
// git hook, and a lane's shell has IDD_RISK_PATHS) would point the validator at another repo than the temporary one
const INHERITED = [
  "DD_DELTA_BASE",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "IDD_RISK_PATHS",
];

const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(Deno.env.toObject()).filter(([k]) => !INHERITED.includes(k)),
  );

const run = async (
  cwd: string,
  cmd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) => {
  const output = await new Deno.Command(cmd, {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    clearEnv: true,
    env: {
      ...baseEnv(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      ...extraEnv,
    },
  }).output();
  return {
    code: output.code,
    text: new TextDecoder().decode(output.stderr),
  };
};

const validatorArgs = [
  "run",
  "--allow-read",
  "--allow-env",
  "--allow-run=git",
  validator,
];

/** a repo with one commit, then `path` added without a QA round */
const changedWithoutQa = async (path: string) => {
  const dir = await Deno.makeTempDir({ prefix: "intent-delta-" });
  await run(dir, "git", ["init", "-q"]);
  await Deno.writeTextFile(`${dir}/README.md`, "x\n");
  await run(dir, "git", ["add", "."]);
  await run(dir, "git", ["commit", "-qm", "base"]);
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  const target = `${dir}/${path}`;
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(target, "void main() {}\n");
  const result = await run(dir, Deno.execPath(), validatorArgs);
  await Deno.remove(dir, { recursive: true });
  return result;
};

/**
 * a repo with one commit, then `path` (a code file) and a QA document of the given risk added without committing,
 * the declaration passed to the validator through IDD_RISK_PATHS.
 */
const changedWithDeclaration = async (
  path: string,
  declaration: Record<string, string[]>,
  risk: string,
  extraEnv: Record<string, string> = {},
) => {
  const dir = await Deno.makeTempDir({ prefix: "intent-delta-risk-" });
  await run(dir, "git", ["init", "-q"]);
  await Deno.writeTextFile(`${dir}/README.md`, "x\n");
  await run(dir, "git", ["add", "."]);
  await run(dir, "git", ["commit", "-qm", "base"]);
  const target = `${dir}/${path}`;
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(target, "void main() {}\n");
  await Deno.mkdir(`${dir}/_docs/qa/demo`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/_docs/qa/demo/qa.md`,
    `---\nrisk: ${risk}\n---\n\nbody\n`,
  );
  const result = await run(dir, Deno.execPath(), validatorArgs, {
    IDD_RISK_PATHS: JSON.stringify(declaration),
    ...extraEnv,
  });
  await Deno.remove(dir, { recursive: true });
  return result;
};

Deno.test("a Dart change without a QA round needs one (a Choice or a Waive)", async () => {
  const result = await changedWithoutQa("lib/main.dart");
  if (result.code === 0 || !result.text.includes("lib/main.dart")) {
    throw new Error(`expected a finding for lib/main.dart: ${result.text}`);
  }
});

Deno.test("a change that is not code needs none", async () => {
  const result = await changedWithoutQa("lib/notes.txt");
  if (result.code !== 0) throw new Error(result.text);
});

Deno.test("the validator holds no default dangerous path: a skills change with no declaration needs no round", async () => {
  const result = await changedWithoutQa("skills/propter-x/SKILL.md");
  if (result.code !== 0) throw new Error(result.text);
});

Deno.test("an adopted repo's own skills/ is not on the risk floor", async () => {
  const result = await changedWithoutQa("skills/own/notes.md");
  if (result.code !== 0) throw new Error(result.text);
});

/**
 * a repo whose base commit holds a maintenance.md with one Low round; the change adds `path` (declared) and appends
 * a round of the given Risk, without committing. The declaration is passed through IDD_RISK_PATHS.
 */
const declaredWithAddedRound = async (
  path: string,
  declaration: Record<string, string[]>,
  roundRisk: string | null,
) => {
  const dir = await Deno.makeTempDir({ prefix: "intent-delta-round-" });
  await run(dir, "git", ["init", "-q"]);
  const qa = `${dir}/_docs/qa/Demo/maintenance.md`;
  await Deno.mkdir(`${dir}/_docs/qa/Demo`, { recursive: true });
  const head =
    "---\nrisk: Low\n---\n\n## Rounds\n\n### Round 2026-10-01 earlier\n\n- **Risk**: High\n- **Verdict**: PASS\n";
  await Deno.writeTextFile(qa, head);
  await run(dir, "git", ["add", "."]);
  await run(dir, "git", ["commit", "-qm", "base"]);
  const target = `${dir}/${path}`;
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(target, "# changed\n");
  const round = roundRisk === null
    ? "\n### Round 2026-10-23 this change\n\n- **Verdict**: PASS\n"
    : `\n### Round 2026-10-23 this change\n\n- **Risk**: ${roundRisk}（理由）\n- **Verdict**: PASS\n`;
  await Deno.writeTextFile(qa, head + round);
  const result = await run(dir, Deno.execPath(), validatorArgs, {
    IDD_RISK_PATHS: JSON.stringify(declaration),
  });
  await Deno.remove(dir, { recursive: true });
  return result;
};

Deno.test("a declared path that is not code needs a round, and the added round's Risk High meets the floor", async () => {
  const declaration = { permission: ["skills/propter-"] };
  const high = await declaredWithAddedRound(
    "skills/propter-x/SKILL.md",
    declaration,
    "High",
  );
  if (high.code !== 0) throw new Error(high.text);
  const missing = await changedWithoutQaDeclared(
    "skills/propter-x/SKILL.md",
    declaration,
  );
  if (missing.code === 0 || !missing.text.includes("skills/propter-x")) {
    throw new Error(`expected a finding: ${missing.text}`);
  }
});

Deno.test("an earlier round's High does not meet the floor for a change whose own round is Low, has no Risk, or glues the word to more text", async () => {
  const declaration = { permission: ["skills/propter-"] };
  for (const risk of ["Low", null, "Highではない"]) {
    const result = await declaredWithAddedRound(
      "skills/propter-x/SKILL.md",
      declaration,
      risk,
    );
    if (result.code === 0 || !result.text.includes("Risk")) {
      throw new Error(`expected a floor finding for ${risk}: ${result.text}`);
    }
  }
});

/** a repo with one commit, then `path` added without a QA round, with a declaration */
const changedWithoutQaDeclared = async (
  path: string,
  declaration: Record<string, string[]>,
) => {
  const dir = await Deno.makeTempDir({ prefix: "intent-delta-declared-" });
  await run(dir, "git", ["init", "-q"]);
  await Deno.writeTextFile(`${dir}/README.md`, "x\n");
  await run(dir, "git", ["add", "."]);
  await run(dir, "git", ["commit", "-qm", "base"]);
  const target = `${dir}/${path}`;
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
    recursive: true,
  });
  await Deno.writeTextFile(target, "# changed\n");
  const result = await run(dir, Deno.execPath(), validatorArgs, {
    IDD_RISK_PATHS: JSON.stringify(declaration),
  });
  await Deno.remove(dir, { recursive: true });
  return result;
};

Deno.test("a declared dangerous path with a Medium QA fails, and the finding names the kind and path", async () => {
  const result = await changedWithDeclaration(
    "lib/passkey.ts",
    { auth: ["lib/passkey"] },
    "Medium",
  );
  if (result.code === 0) throw new Error(`expected a finding: ${result.text}`);
  if (
    !result.text.includes("auth") || !result.text.includes("lib/passkey.ts")
  ) {
    throw new Error(
      `expected the kind and path in the finding: ${result.text}`,
    );
  }
});

Deno.test("a declared dangerous path with a High QA passes", async () => {
  const result = await changedWithDeclaration(
    "lib/passkey.ts",
    { auth: ["lib/passkey"] },
    "High",
  );
  if (result.code !== 0) throw new Error(result.text);
});

Deno.test("a declared dangerous path with a Critical QA passes", async () => {
  const result = await changedWithDeclaration(
    "lib/passkey.ts",
    { auth: ["lib/passkey"] },
    "Critical",
  );
  if (result.code !== 0) throw new Error(result.text);
});

Deno.test("a prefix match reaches a deep file under the declared directory", async () => {
  const result = await changedWithDeclaration(
    "lib/deep/nested/passkey-client.ts",
    { auth: ["lib/deep"] },
    "Medium",
  );
  if (result.code === 0) throw new Error(`expected a finding: ${result.text}`);
  if (!result.text.includes("lib/deep/nested/passkey-client.ts")) {
    throw new Error(`expected the deep path in the finding: ${result.text}`);
  }
});

Deno.test("a path that no declared prefix matches keeps the old behaviour", async () => {
  const result = await changedWithDeclaration(
    "lib/other.ts",
    { auth: ["lib/passkey"] },
    "Medium",
  );
  if (result.code !== 0) throw new Error(result.text);
});

Deno.test("an unreadable declaration fails the check", async () => {
  const result = await changedWithDeclaration(
    "lib/passkey.ts",
    { auth: ["lib/passkey"] },
    "High",
    { IDD_RISK_PATHS: "{" },
  );
  if (result.code === 0 || !result.text.includes("IDD_RISK_PATHS")) {
    throw new Error(`expected a declaration error: ${result.text}`);
  }
});

Deno.test("the self-test does not inherit the caller's declaration", async () => {
  // a declaration that matches the fixture's `lib/` path, put where baseEnv must filter it out
  Deno.env.set("IDD_RISK_PATHS", JSON.stringify({ auth: ["lib/"] }));
  try {
    const result = await changedWithDeclaration(
      "lib/other.ts",
      { auth: ["lib/"] },
      "Medium",
      { IDD_RISK_PATHS: JSON.stringify({ auth: ["lib/"] }) },
    );
    // the explicit extraEnv declares it, so this one does fail; the point is the self-test's own child does not
    // see the process-level variable unless baseEnv excludes it
    if (result.code === 0) {
      throw new Error(`expected a finding: ${result.text}`);
    }
    const noDeclaration = await changedWithoutQa("lib/notes.txt");
    if (noDeclaration.code !== 0) throw new Error(noDeclaration.text);
  } finally {
    Deno.env.delete("IDD_RISK_PATHS");
  }
});
