import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBashCommand } from "../src/intent/bash.ts";

const reads = (command) => parseBashCommand(command).reads;
const writes = (command) => parseBashCommand(command).writes;

test("AC-001: the reading commands name the files they open", () => {
  assert.deepEqual(reads("cat a.ts"), ["a.ts"]);
  assert.deepEqual(reads("head -n 20 a.ts"), ["a.ts"]);
  assert.deepEqual(reads("tail -5 a.ts"), ["a.ts"]);
  assert.deepEqual(reads("less a.ts"), ["a.ts"]);
  assert.deepEqual(reads("sed -n '1,40p' a.ts"), ["a.ts"]);
  assert.deepEqual(reads("cat a.ts b.ts"), ["a.ts", "b.ts"]);
  // `sed -i` rewrites in place: it is a write, not a read
  assert.deepEqual(reads("sed -i 's/a/b/' a.ts"), []);
  assert.deepEqual(writes("sed -i 's/a/b/' a.ts"), ["a.ts"]);
});

test("AC-002: python's open() calls are read from -c and from a heredoc script", () => {
  assert.deepEqual(reads('python3 -c "print(open(\'a.ts\').read())"'), ["a.ts"]);
  assert.deepEqual(reads("python3 <<'EOF'\nprint(open(\"a.ts\", \"r\").read())\nEOF"), ["a.ts"]);
  // the script file itself is executed, not opened
  assert.deepEqual(reads("python3 script.py"), []);
});

test("AC-003: reads are found through pipes, `&&`, `;` and newlines", () => {
  assert.deepEqual(reads("cat a.ts | grep x"), ["a.ts"]);
  assert.deepEqual(reads("ls && head a.ts"), ["a.ts"]);
  assert.deepEqual(reads("cat a.ts; cat b.ts"), ["a.ts", "b.ts"]);
  assert.deepEqual(reads("cat a.ts\ncat b.ts"), ["a.ts", "b.ts"]);
  // `head` here has no path of its own, and the grep is not a read
  assert.deepEqual(reads("grep x a.ts | head"), []);
});

test("AC-004: git plumbing and the search tools are not reads", () => {
  for (const command of ["git show HEAD:a.ts", "git diff -- a.ts", "git log -p a.ts", "grep foo a.ts", "rg foo a.ts"]) {
    assert.deepEqual(reads(command), [], command);
  }
});

test("AC-008: the writing commands name the files they write", () => {
  assert.deepEqual(writes("sed -i 's/a/b/' a.ts"), ["a.ts"]);
  assert.deepEqual(writes("sed -i.bak -e 's/a/b/' a.ts b.ts"), ["a.ts", "b.ts"]);
  assert.deepEqual(writes("echo x > a.ts"), ["a.ts"]);
  assert.deepEqual(writes("echo x >> a.ts"), ["a.ts"]);
  assert.deepEqual(writes("cat > a.ts <<'EOF'\nhello\nEOF"), ["a.ts"]);
  assert.deepEqual(writes("echo x | tee a.ts"), ["a.ts"]);
  assert.deepEqual(writes("tee -a a.ts b.ts"), ["a.ts", "b.ts"]);
  // a file descriptor is not a file
  assert.deepEqual(writes("npm test > out.log 2>&1"), ["out.log"]);
  assert.deepEqual(writes("echo x >&2"), []);
});

test("AC-009: python's open() mode decides read and write", () => {
  assert.deepEqual(writes('python3 -c "open(\'a.ts\',\'w\').write(\'x\')"'), ["a.ts"]);
  assert.deepEqual(writes('python3 -c "open(\'a.ts\',\'a\').write(\'x\')"'), ["a.ts"]);
  assert.deepEqual(writes("python3 <<'EOF'\nopen('a.ts', 'w').write('x')\nEOF"), ["a.ts"]);
  // a mode-less open and an explicit read are reads
  assert.deepEqual(writes("python3 -c \"open('a.ts').read()\""), []);
  assert.deepEqual(writes('python3 -c "open(\'a.ts\', \'r\').read()"'), []);
  assert.deepEqual(reads('python3 -c "open(\'a.ts\', \'r\').read()"'), ["a.ts"]);
});

test("AC-010: a symbol inside quotes or a heredoc body is not a write", () => {
  assert.deepEqual(writes('echo "a > b.ts"'), []);
  assert.deepEqual(writes("grep '>' a.ts"), []);
  // only the heredoc's own target is written; the body's `>` writes nothing
  assert.deepEqual(writes("cat > _meta/scratch/x.sh <<'EOF'\necho y > src/b.ts\nEOF"), ["_meta/scratch/x.sh"]);
});

test("AC-016: a path that cannot be pinned down is not read or written", () => {
  for (const command of ['echo x > "$OUT"', "echo x > src/*.ts", "echo x > $(mktemp)", "sed -i s/a/b/ $FILES", 'cd "$DIR" && echo x > a.ts']) {
    assert.deepEqual(writes(command), [], command);
  }
  // a command whose quotes never close yields nothing, and never throws
  assert.deepEqual(writes('echo x > "a.ts'), []);
  assert.deepEqual(reads("cat 'a.ts"), []);
});

test("AC-017: a relative path after `cd` is resolved in the directory it moved to", () => {
  assert.deepEqual(writes("cd /tmp && echo x > out.txt"), ["/tmp/out.txt"]);
  assert.deepEqual(writes("cd packages && sed -i s/a/b/ x.ts"), ["packages/x.ts"]);
  assert.deepEqual(reads("cd packages && cat x.ts"), ["packages/x.ts"]);
  // the `cd` only moves the base for what follows it
  assert.deepEqual(reads("cat a.ts && cd packages && cat b.ts"), ["a.ts", "packages/b.ts"]);
});

test("a path that cannot be pinned down does not stop another one from being read", () => {
  assert.deepEqual(reads("cat $A b.ts"), ["b.ts"]);
});
