import type { DslNode, ReuseCandidate } from "../types/dsl.js";

/**
 * DFS traversal helper that records each node and its path.
 */
function walk(node: DslNode, currentPath: string, out: Array<{ path: string; node: DslNode }>): void {
  out.push({ path: currentPath, node });
  node.children?.forEach((child, index) => {
    walk(child, `${currentPath}.children[${index}]`, out);
  });
}

/**
 * Detects reusable candidates by grouping same (type + name) repeated nodes.
 */
export function detectReuseCandidates(root: DslNode): ReuseCandidate[] {
  const flat: Array<{ path: string; node: DslNode }> = [];
  walk(root, "root", flat);

  const grouped = new Map<string, string[]>();
  for (const item of flat) {
    if (!item.node.name) continue;
    const key = `${item.node.type}:${item.node.name}`;
    const paths = grouped.get(key) ?? [];
    paths.push(item.path);
    grouped.set(key, paths);
  }

  const candidates: ReuseCandidate[] = [];
  for (const [key, paths] of grouped.entries()) {
    if (paths.length < 2) continue;
    const [type, name] = key.split(":");
    candidates.push({
      id: `${type}_${name}`.replace(/\W+/g, "_"),
      name,
      reason: `Found ${paths.length} repeated "${type}" modules`,
      nodePaths: paths
    });
  }

  return candidates;
}

/**
 * Recursively marks nodes that belong to a reusable candidate.
 */
function markNode(node: DslNode, targetName: string, candidateId: string): DslNode {
  const next: DslNode = {
    ...node,
    children: node.children?.map((child) => markNode(child, targetName, candidateId))
  };

  if (node.name === targetName) {
    next.reusable = true;
    next.reusableCandidateId = candidateId;
    next.reusability = {
      candidateId,
      status: "pending_review"
    };
  }

  return next;
}

/**
 * Annotates DSL with all detected reusable candidates before review.
 */
export function annotateReuseCandidates(root: DslNode, candidates: ReuseCandidate[]): DslNode {
  let next = { ...root } as DslNode;
  for (const candidate of candidates) {
    next = markNode(next, candidate.name, candidate.id);
  }
  return next;
}

/**
 * Applies user approval decisions onto candidate annotations.
 */
export function applyReuseApprovals(
  root: DslNode,
  candidates: ReuseCandidate[],
  decisions: Record<string, boolean>
): DslNode {
  function walkApply(node: DslNode): DslNode {
    const nextNode: DslNode = {
      ...node,
      children: node.children?.map(walkApply)
    };

    if (!nextNode.reusability) {
      return nextNode;
    }

    const approved = decisions[nextNode.reusability.candidateId];
    nextNode.reusability = {
      ...nextNode.reusability,
      status: approved ? "approved" : "rejected"
    };
    nextNode.reusable = true;
    return nextNode;
  }

  // Ensure every candidate is represented in DSL before approval statuses are applied.
  const annotated = annotateReuseCandidates(root, candidates);
  return walkApply(annotated);
}
