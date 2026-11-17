import tseslint from "typescript-eslint";

const eslintConfig = [
  // `_meta/` は運用の読書面の外の資料である（`_docs/standards/document_contracts.md`）。採用側の
  // linter の対象から外す（`_docs/standards/template_operations.md`）。参照用の prototype は設計ツールの
  // export で、repo の source ではない。画面の build の出力と、その作り途中の場所も repo の source ではない。
  // `packages/idd-fold/` の `dist/` と `_build/` は MoonBit の build の出力で、repo の source ではない
  // （源は同じ dir の .mbt と、その隣の TS）。
  // `state/` は engine の状態の置き場（lane の複製や lock を含み、走っている間に増減する）で、repo の source ではない。
  // 本流の checkout で lint すると歩きに行き、消えた lock で落ちることがあった（2026-10-25）。
  { ignores: ["_meta/**", "state/**", "packages/idd-gui/dist*/**", "packages/idd-fold/dist/**", "packages/idd-fold/_build/**"] },
  ...tseslint.configs.recommended,
  // 未使用の変数と式は警告に留める。数は取り込みの検査が増分で止める（config/repos.yaml の eslint-warnings）
  { rules: { "@typescript-eslint/no-unused-vars": "warn", "@typescript-eslint/no-unused-expressions": "warn" } },
];

export default eslintConfig;
