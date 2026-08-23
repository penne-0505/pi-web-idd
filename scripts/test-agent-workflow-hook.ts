import {
  analyzePreToolUse,
  analyzeStop,
  isWorkflowSensitivePath,
  parsePorcelainPaths,
} from "./agent-workflow-hook.ts";

const assert = (condition: unknown, message: string): void => {
  if (!condition) {
    console.error(`FAIL ${message}`);
    Deno.exit(1);
  }
  console.log(`PASS ${message}`);
};

assert(
  parsePorcelainPaths(" M TODO.md\nR  old.md -> new.md\n?? scripts/x.mjs\n")
    .join(",") === "TODO.md,old.md,new.md,scripts/x.mjs",
  "parse git porcelain paths",
);

assert(
  isWorkflowSensitivePath("AGENTS.md") &&
    isWorkflowSensitivePath("./_docs/standards/workflow.md") &&
    isWorkflowSensitivePath(".claude/settings.json") &&
    !isWorkflowSensitivePath("README.md") &&
    !isWorkflowSensitivePath("_docs/qa/Workflow/x/qa.md"),
  "single workflow-sensitive predicate",
);

assert(
  analyzePreToolUse({
    tool_name: "Write",
    tool_input: { file_path: "src/example.ts" },
  }) === null,
  "ordinary writes pass without injected context (no per-write sermon)",
);

assert(
  analyzePreToolUse({
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
  }) === null,
  "read-only tools pass silently",
);

const gitRmBlock = analyzePreToolUse({
  tool_name: "Bash",
  tool_input: { command: "git rm _docs/qa/Core/x/qa.md" },
});
assert(
  gitRmBlock?.decision === "block" &&
    gitRmBlock.reason.includes("Why:") &&
    gitRmBlock.reason.includes("Next action:"),
  "block git rm with why and next action",
);

assert(
  analyzePreToolUse({
    tool_name: "Bash",
    tool_input: { command: "rm -rf _docs/intent/Core/x" },
  })?.decision === "block",
  "block rm",
);

for (
  const bypass of [
    "/bin/rm file.ts",
    "command rm file.ts",
    "xargs rm < list.txt",
    "find . -name '*.md' -delete",
    "shred secret.txt",
    "unlink file.ts",
  ]
) {
  assert(
    analyzePreToolUse({
      tool_name: "Bash",
      tool_input: { command: bypass },
    })?.decision === "block",
    `block deletion bypass: ${bypass}`,
  );
}

assert(
  analyzePreToolUse({
    tool_name: "apply_patch",
    tool_input: { command: "*** Begin Patch\n*** Delete File: README.md\n" },
  })?.decision === "block",
  "block apply_patch file deletion",
);

assert(
  analyzePreToolUse({
    tool_name: "Write",
    tool_input: { file_path: ".env" },
  })?.decision === "block",
  "block sensitive file edit",
);

assert(
  analyzePreToolUse({
    tool_name: "Bash",
    tool_input: { command: "cat .env" },
  })?.decision === "block",
  "block reading credential files",
);

assert(
  analyzePreToolUse({
    tool_name: "Bash",
    tool_input: { command: "cat .env.example" },
  }) === null,
  "allow .env.example (the file the security standard points to)",
);

const stopReminder = analyzeStop({
  dirtyPaths: ["TODO.md", "src/app.ts"],
  input: {},
});
const stopReason = stopReminder?.decision === "block"
  ? stopReminder.reason
  : "";
assert(
  stopReason.includes("追いついていますか") &&
    stopReason.includes("無視して") &&
    stopReason.includes("作業を始めないでください") &&
    stopReason.includes("本筋の次の指示"),
  "stop reminder is a single ignorable question with explicit response shape",
);

assert(
  stopReason !== "" &&
    !/verification|verdict|検証|反証|残リスク/.test(stopReason),
  "stop reminder carries no keyword-compliance vocabulary demands",
);

assert(
  analyzeStop({ dirtyPaths: [], input: {} }) === null,
  "stop hook stays silent with a clean working tree",
);

assert(
  analyzeStop({
    dirtyPaths: ["notes.txt"],
    input: {},
  }) === null,
  "stop hook stays silent when no loop-relevant files changed",
);

assert(
  analyzeStop({
    dirtyPaths: ["README.md", "src/app.ts"],
    input: { stop_hook_active: true },
  }) === null,
  "stop hook avoids recursive block",
);

const HOOK_SCRIPT = `${Deno.cwd()}/scripts/agent-workflow-hook.ts`;

const sanitizedEnv = (): Record<string, string> => {
  const env = { ...Deno.env.toObject() };
  delete env.LD_LIBRARY_PATH;
  delete env.LD_PRELOAD;
  return env;
};

const runGitIn = async (cwd: string, args: string[]): Promise<void> => {
  const output = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: sanitizedEnv(),
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
};

const runStopHook = async (
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const command = new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    clearEnv: true,
    env: sanitizedEnv(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(
    new TextEncoder().encode(
      JSON.stringify({ hook_event_name: "Stop" }),
    ),
  );
  await writer.close();
  const output = await child.output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
};

const stopFixture = await Deno.makeTempDir({ prefix: "docs-dd-stop-hook-" });
try {
  await Deno.writeTextFile(`${stopFixture}/TODO.md`, "# TODO\n");
  await runGitIn(stopFixture, ["init", "--quiet"]);
  await runGitIn(stopFixture, ["config", "user.email", "hook@example.test"]);
  await runGitIn(stopFixture, ["config", "user.name", "Hook"]);
  await runGitIn(stopFixture, ["add", "TODO.md"]);
  await runGitIn(stopFixture, ["commit", "--quiet", "-m", "base"]);
  await Deno.writeTextFile(`${stopFixture}/TODO.md`, "# TODO\n\ndirty\n");

  const stopWithContract = await runStopHook([
    "run",
    "--allow-read",
    "--allow-env",
    "--allow-run=git",
    HOOK_SCRIPT,
    "stop",
  ], stopFixture);
  assert(
    stopWithContract.code === 0 &&
      stopWithContract.stdout.includes('"decision":"block"'),
    "Stop hook reminds under declared --allow-read --allow-env --allow-run=git",
  );

  const stopWithoutEnv = await runStopHook([
    "run",
    "--allow-read",
    "--allow-run=git",
    HOOK_SCRIPT,
    "stop",
  ], stopFixture);
  assert(
    stopWithoutEnv.code !== 0 &&
      stopWithoutEnv.stderr.includes("--allow-env") &&
      !stopWithoutEnv.stdout.includes('"decision"'),
    "Stop hook fails closed without --allow-env instead of silent skip",
  );
} finally {
  await Deno.remove(stopFixture, { recursive: true });
}
