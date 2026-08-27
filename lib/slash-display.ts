// intent: DEC-242 — pi の _expandSkillCommand が出した完全 envelope のみを表示上で縮約する

const SKILL_EXPANSION_RE = /^<skill name="([^"\n]+)" location="([^"\n]+)">\nReferences are relative to [^\n]+\.\n\n([\s\S]*)\n<\/skill>(?:\n\n([\s\S]+))?$/;

// intent: DEC-242 — 開頭 envelope + base-dir + 末尾閉じタグ + optional args を全一致で要求、body は greedy で末尾閉じタグ優先

export function skillExpansionToCommand(text: string): string | null {
  const match = text.match(SKILL_EXPANSION_RE);
  if (!match) return null;

  const [, name, , , args] = match;
  return args ? `/skill:${name} ${args}` : `/skill:${name}`;
}
