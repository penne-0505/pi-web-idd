/**
 * What node's spec reporter writes for four failed leaves: two of them share the name `dup` in different suites, and
 * the progress part also lists the suites (`suite A`, `nested`, `other`) the count does not include. Trimmed from a
 * run on node 24 (stack lines left out).
 */
export const NODE_SPEC_FOUR_FAILED = `▶ suite A
  ✖ dup (2.9ms)
  ▶ nested
    ✖ leaf (0.2ms)
  ✖ nested (2.2ms)
✖ suite A (6.8ms)
▶ other
  ✖ dup (10.2ms)
✖ other (10.5ms)
✖ top (0.8ms)
ℹ tests 4
ℹ suites 3
ℹ pass 0
ℹ fail 4

✖ failing tests:

test at x.test.mjs:2:29
✖ dup (2.9ms)
  Error: a

test at x.test.mjs:2:102
✖ leaf (0.2ms)
  Error: b

test at x.test.mjs:3:27
✖ dup (10.2ms)
  Error: c

test at x.test.mjs:4:1
✖ top (0.8ms)
  Error: d
`;

/**
 * What `bun test` writes when two files each hold a failed test of the same name (`s > same name`): a file line
 * above each file's tests, then the recap that lists the failures again without a file line, then the counts. Trimmed
 * from a run on bun 1.3.14 (the other lines of a test left out).
 */
export const BUN_SAME_NAME_IN_TWO_FILES = `packages/x/a.test.ts:
(pass) s > ok [1.00ms]
(fail) s > same name [2.00ms]

packages/x/b.test.ts:
(fail) s > same name [3.00ms]

2 tests failed:
(fail) s > same name [2.00ms]
(fail) s > same name [3.00ms]

 1 pass
 2 fail
`;
