// 記録が公開側へ漏れていないかの検査: manifest があるとき、_docs/ の standards 以外と
// root の TODO.md が、どれもその除外に当たることを確かめる。当たらないファイルがあれば
// パスを出して落ちる。manifest の無い repo では何もしない。
// これは pi-web-idd 自身の記録を守る検査である。採用先の記録の扱いは採用先の
// overlay.manifest が正で、manifest が _docs/ を丸ごと外す形（idd init が作る形）では
// 何もしない。
// manifest の読み方（前方一致、末尾の / はディレクトリ）は packages 側と同じ規則だが、
// 採用先には scripts/ だけが写るので、この検査は scripts/ の中で閉じる。

const MANIFEST_FILE = "overlay.manifest";
/** the only part of _docs/ that the public side carries: the norms and their templates */
const PUBLIC_STANDARDS = "_docs/standards/";

const normalize = (raw: string): string => {
  let value = raw.trim();
  if (value.startsWith("./")) value = value.slice(2);
  const isDir = value.endsWith("/");
  while (value.endsWith("/")) value = value.slice(0, -1);
  return isDir ? `${value}/` : value;
};

export const parseManifest = (text: string): string[] => {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const entry = normalize(trimmed);
    if (entry.startsWith("/") || entry.includes("..")) continue;
    paths.push(entry);
  }
  return paths;
};

export const isOverlayPath = (paths: string[], file: string): boolean => {
  const target = normalize(file);
  return paths.some((p) =>
    p.endsWith("/") ? target.startsWith(p) : target === p
  );
};

// -z は NUL 区切りの生のパスを返す。既定の出力は非 ASCII のパスを引用符と 8 進の
// escape で包むので、そのままでは除外に当たる記録を漏れと誤判定する。
const recordFiles = async (): Promise<string[]> => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command("git", {
      args: ["ls-files", "-z", "--", "_docs", "TODO.md"],
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (err) {
    throw new Error(
      `git ls-files could not run (need --allow-run=git): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!output.success) {
    throw new Error(`git ls-files failed (exit ${output.code})`);
  }
  return new TextDecoder()
    .decode(output.stdout)
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.startsWith(PUBLIC_STANDARDS));
};

const run = async (): Promise<void> => {
  let text: string;
  try {
    text = await Deno.readTextFile(MANIFEST_FILE);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
  const paths = parseManifest(text);
  // 採用先（idd init が作る manifest）は _docs/ を丸ごと外す。その形では記録がすべて
  // 外れているので、この検査は何もしない。pi-web-idd 自身の形にだけ効かせる。
  if (isOverlayPath(paths, "_docs/")) return;
  const leaked = (await recordFiles()).filter((file) =>
    !isOverlayPath(paths, file)
  );
  if (leaked.length) {
    console.error(
      `ERROR: ${leaked.length} 件の記録が ${MANIFEST_FILE} の除外に当たりません。このままでは公開側にこの repo の記録が出ます:`,
    );
    for (const file of leaked) console.error(`  - ${file}`);
    console.error(
      `記録のディレクトリ（またはファイル）を ${MANIFEST_FILE} に足してください。`,
    );
    Deno.exit(1);
  }
};

run().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  Deno.exit(1);
});
