import assert from "node:assert/strict";
import test from "node:test";

const isWindows = process.platform === "win32";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./paths.ts");
}

test("toNativePath converts git's POSIX output to native separators", async () => {
  const { toNativePath } = await loadSubject();
  if (isWindows) {
    // intent: DEC-128 — git の POSIX 形式 path 出力を native と比較可能にする regression check
    assert.equal(toNativePath("D:/repo/sub"), "D:\\repo\\sub");
    assert.equal(toNativePath("D:\\repo\\sub"), "D:\\repo\\sub");
  } else {
    assert.equal(toNativePath("/repo/sub"), "/repo/sub");
  }
  assert.equal(toNativePath(""), "");
});

test("samePath ignores separator style and Windows case", async () => {
  const { samePath } = await loadSubject();
  assert.equal(samePath("/a/b", "/a/b"), true);
  assert.equal(samePath("/a/b/", "/a/b"), true, "trailing separators must not matter");
  assert.equal(samePath("/a/./b", "/a/b"), true, "dot segments must not matter");
  assert.equal(samePath("/a/b", "/a/c"), false);
  assert.equal(samePath("", ""), true);
  assert.equal(samePath("", "/a"), false);

  if (isWindows) {
    assert.equal(samePath("D:/repo", "D:\\repo"), true, "separator style must not matter");
    assert.equal(samePath("d:\\repo", "D:\\repo"), true, "drive-letter case must not matter");
    assert.equal(samePath("D:\\Repo\\Sub", "d:/repo/sub"), true);
    assert.equal(samePath("D:\\repo\\", "D:/repo"), true);
    assert.equal(samePath("D:\\repo", "D:\\repo2"), false);
  } else {
    // intent: DEC-130 — POSIX は case-sensitive、backslash はファイル名として合法なので Windows と別軌道
    assert.equal(samePath("/Repo", "/repo"), false);
    assert.equal(samePath("/a\\b", "/a/b"), false);
  }
});

test("toSlashPath normalizes to forward slashes", async () => {
  const { toSlashPath } = await loadSubject();
  assert.equal(toSlashPath("D:\\repo\\sub"), "D:/repo/sub");
  assert.equal(toSlashPath("/repo/sub"), "/repo/sub");
});

test("isWindowsAbsolutePath recognizes drive and UNC paths", async () => {
  const { isWindowsAbsolutePath } = await loadSubject();
  assert.equal(isWindowsAbsolutePath("D:\\repo"), true);
  assert.equal(isWindowsAbsolutePath("d:/repo"), true);
  assert.equal(isWindowsAbsolutePath("\\\\server\\share"), true);
  assert.equal(isWindowsAbsolutePath("relative/path"), false);
});
