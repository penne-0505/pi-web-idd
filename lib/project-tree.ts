import type { BranchPreview } from "@/lib/types";

// intent: DEC-244 — client 側 BranchNavigator が再帰走査するため response tree は必ず浅く保つ

export const MAX_PROJECTED_TREE_DEPTH = 200;
const MAX_BRANCH_PREVIEW_LENGTH = 40;

type ProjectableEntry = {
  id: string;
  type: string;
  message?: unknown;
};

type ProjectableTreeNode<T> = {
  entry: ProjectableEntry;
  children: T[];
  compressedEntryIds?: string[];
  branchPreview?: BranchPreview;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendPreviewText(current: string, value: unknown): string {
  if (typeof value !== "string" || current.length > MAX_BRANCH_PREVIEW_LENGTH) return current;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return current;
  const separator = current ? " " : "";
  const prefix = current + separator;
  if (prefix.length >= MAX_BRANCH_PREVIEW_LENGTH + 1) {
    return prefix.slice(0, MAX_BRANCH_PREVIEW_LENGTH + 1);
  }
  const remaining = MAX_BRANCH_PREVIEW_LENGTH + 1 - prefix.length;
  return prefix + normalized.slice(0, remaining);
}

function previewForEntry(entry: ProjectableEntry): BranchPreview | undefined {
  if (entry.type !== "message" || !isRecord(entry.message) || typeof entry.message.role !== "string") {
    return undefined;
  }

  const content = entry.message.content;
  let text = "";
  let hasImage = false;
  if (typeof content === "string") {
    text = appendPreviewText(text, content);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === "image") hasImage = true;
      if (block.type === "text") text = appendPreviewText(text, block.text);
      if (text.length > MAX_BRANCH_PREVIEW_LENGTH) break;
    }
  }

  if (text.length > MAX_BRANCH_PREVIEW_LENGTH) {
    text = text.slice(0, MAX_BRANCH_PREVIEW_LENGTH) + "…";
  } else if (!text) {
    text = hasImage
      ? "[image]"
      : entry.message.role === "assistant"
        ? "[assistant]"
        : "message";
  }

  const role = entry.message.role === "user" || entry.message.role === "assistant"
    ? entry.message.role
    : undefined;
  return { ...(role ? { role } : {}), text };
}

// intent: DEC-244 — root・分岐点・葉のみ残し、単一子鎖は圧縮した entry ID を次残存ノードに載せる

export function projectTreeForResponse<T extends ProjectableTreeNode<T>>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[], branchPreview?: BranchPreview): T => ({
    ...node,
    children: [],
    ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
    ...(branchPreview ? { branchPreview } : {}),
  });
  const projectedRoots = nodes.map((node) => cloneNode(node, undefined, previewForEntry(node.entry)));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{
      node: source,
      compressedEntryIds: [] as string[],
      branchPreview: undefined as BranchPreview | undefined,
    }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds, branchPreview } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);
      const nextPreview = branchPreview ?? previewForEntry(node.entry);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds, nextPreview));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
          branchPreview: keep.has(node) ? undefined : nextPreview,
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      let branchPreview = previewForEntry(child.entry);
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        child = child.children[0];
        branchPreview ??= previewForEntry(child.entry);
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds, branchPreview);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}
