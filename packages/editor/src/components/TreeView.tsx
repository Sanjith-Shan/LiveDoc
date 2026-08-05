import type { TreeNodeJSON } from "@weave/core";

function Node({ node, depth }: { node: TreeNodeJSON; depth: number }) {
  return (
    <div className="tree-node">
      <div className={`tree-row ${node.deleted ? "tree-row-deleted" : ""} ${node.skeleton ? "tree-row-skeleton" : ""}`} style={{ paddingLeft: depth * 16 }}>
        <span className="tree-id">{node.id}</span>
        <span className={`tree-side tree-side-${node.side}`}>{node.side}</span>
        <span className="tree-content">
          {node.skeleton ? (
            <em>skeleton</em>
          ) : node.content === null ? (
            <em>∅</em>
          ) : (
            <span className={node.deleted ? "tree-strike" : undefined}>{JSON.stringify(node.content)}</span>
          )}
        </span>
        <span className="tree-length">len {node.length}</span>
      </div>
      {node.children.map((child, i) => (
        <Node key={`${child.id}-${i}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

/**
 * Indented tree over a force graph, on purpose: node ids, run content, side
 * (L/R) and tombstone state all need to be *read*, not just glanced at, and
 * indentation reads left-to-right the way the document does.
 */
export function TreeView({ root }: { root: TreeNodeJSON | null }) {
  if (!root) {
    return <div className="tree-empty">No tree yet — type in the Collaborate tab.</div>;
  }
  return (
    <div className="tree-view">
      <Node node={root} depth={0} />
    </div>
  );
}
