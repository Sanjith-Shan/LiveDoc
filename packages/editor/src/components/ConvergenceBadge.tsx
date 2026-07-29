import { shortHash } from "../lib/diff";

export interface ConvergencePane {
  replica: string;
  label: string;
  text: string;
}

/**
 * Honest by construction: it only ever compares the panes' *current*
 * `toString()` output. While a chaos-delayed update is genuinely still in
 * flight, the texts really do differ, so this reads "diverged" for exactly
 * as long as that is true — nothing here is faked for the demo.
 */
export function ConvergenceBadge({ panes }: { panes: ConvergencePane[] }) {
  const first = panes[0];
  if (!first) return null;

  const diverged = panes.filter((p) => p.text !== first.text);
  const converged = diverged.length === 0;

  return (
    <div className={`convergence-badge ${converged ? "convergence-ok" : "convergence-warn"}`}>
      <span className="convergence-dot" />
      {converged ? (
        <span>
          converged · <code>{shortHash(first.text)}</code> · {panes.length} panes
        </span>
      ) : (
        <span>
          diverged ({diverged.length} of {panes.length} panes in flight)
        </span>
      )}
    </div>
  );
}
