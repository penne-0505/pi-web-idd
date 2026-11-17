/**
 * The little markdown the screen draws. Only paragraphs, line breaks, fenced code and inline code become elements;
 * everything else stays text. The point is not to render markdown well but to never let the text a model or a tool
 * wrote become markup: the conversation body goes into React as children, and React escapes it.
 */

export interface InlineText {
  kind: "text";
  text: string;
}
export interface InlineCode {
  kind: "code";
  text: string;
}
export interface InlineBreak {
  kind: "break";
}
export type Inline = InlineText | InlineCode | InlineBreak;

export interface ParagraphBlock {
  kind: "paragraph";
  inlines: Inline[];
}
export interface CodeBlock {
  kind: "code";
  lang: string;
  text: string;
}
export type MdBlock = ParagraphBlock | CodeBlock;

/** split one paragraph's text into text runs, inline code runs and line breaks */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const parts = text.split("`");
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      out.push({ kind: "code", text: part });
      return;
    }
    const lines = part.split("\n");
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) out.push({ kind: "break" });
      if (line) out.push({ kind: "text", text: line });
    });
  });
  return out;
}

function isFence(line: string): boolean {
  return line.trimStart().startsWith("```");
}

/** blocks of one message body */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.split("\n");
  const blocks: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isFence(line)) {
      const lang = line.trimStart().slice(3).trim();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isFence(lines[i])) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join("\n")) });
  }
  return blocks;
}
