# Validator fixtures

These fixtures exercise the repository validators themselves.

They are not active project tasks or QA records. `scripts/test-validators.ts`
runs the validators against these files and expects:

- files under `valid/` to pass;
- files under `invalid/` to fail.

The intent, QA, and frontmatter fixtures run through their validators with
`--fixture` and use `fixture_path` front matter so the validators can apply the
normal canonical-path rules while the fixture files remain under `_meta/`.

The QA invalid fixture without `qa_schema` also verifies legacy compatibility:
legacy plans still require an `INV-*`, while schema v2 accepts `None`.

Frontmatter fixtures cover every accepted schema marker value (`intent_schema`
2-3 / `qa_schema` 2-5, kept in sync with the intent and QA validators),
duplicate fields, unknown keys, wrong types, and cross-kind marker placement.
