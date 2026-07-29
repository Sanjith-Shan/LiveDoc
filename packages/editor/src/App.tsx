import { useCallback, useEffect, useMemo, useState } from "react";
import { useDoc } from "./hooks/useDoc";
import { Tabs, type TabKey } from "./components/Tabs";
import { Pane } from "./components/Pane";
import { PresenceBar } from "./components/PresenceBar";
import { ChaosPanel, type ChaosScriptPhase } from "./components/ChaosPanel";
import { PacketLanes } from "./components/PacketLanes";
import { ConvergenceBadge } from "./components/ConvergenceBadge";
import { AnomalyLab } from "./components/AnomalyLab";
import { DEFAULT_CHAOS, probeServer, type ChaosConfig } from "./net/transport";
import { makePaneIdentity } from "./lib/identity";
import { colorForIndex } from "./lib/colors";

const PANE_SLOTS = 4;
const MIN_PANES = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Timings for the "go offline, type, come back" script. The partition is
// held open well past the typing itself so the offline/diverged state sits
// on screen long enough to be caught by a screenshot regardless of exactly
// how fast the scripted typing races through; the convergence step below is
// polled against the real docs, not slept for, so it can't drift out of
// sync with what the transport is actually doing.
const SCRIPT_CUT_SETTLE_MS = 500;
const SCRIPT_OFFLINE_HOLD_MS = 3600;
const SCRIPT_CONVERGE_POLL_MS = 80;
const SCRIPT_CONVERGE_TIMEOUT_MS = 6000;
const SCRIPT_CONVERGED_HOLD_MS = 900;

/** Wording for the phase indicator, driven by `runOfflineScript`'s own
 * step counter — never a separate timer. `step` 0 means no script running. */
function scriptPhaseFor(step: number, offlineName: string): ChaosScriptPhase | null {
  const label = {
    1: `cutting ${offlineName}'s connection`,
    2: "both replicas typing, offline",
    3: "reconnecting",
    4: "converged",
  }[step];
  return label ? { step, total: 4, label } : null;
}

type Theme = "light" | "dark";

function usePersistedTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = window.localStorage.getItem("weave-theme");
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      // ignore
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("weave-theme", theme);
    } catch {
      // ignore
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

/**
 * Resolves whether a real @weave/server is reachable before mounting
 * any Doc/Transport, so every pane's transport is created exactly once
 * against a settled decision — this app never has to hot-swap a live
 * transport mid-session.
 */
export default function App() {
  const [theme, toggleTheme] = usePersistedTheme();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const serverUrl = params.get("server") ?? "ws://localhost:8787";
  const room = params.get("room") ?? "weave-demo";

  const [networkMode, setNetworkMode] = useState<"checking" | "server" | "loopback">("checking");

  useEffect(() => {
    let cancelled = false;
    probeServer(serverUrl).then((ok) => {
      if (!cancelled) setNetworkMode(ok ? "server" : "loopback");
    });
    return () => {
      cancelled = true;
    };
  }, [serverUrl]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <span className="app-brand-mark">◆</span>
          <span className="app-brand-name">Weave</span>
          <span className="app-brand-sub">CRDT editor</span>
        </div>
        <button type="button" className="ghost-btn theme-toggle" onClick={toggleTheme}>
          {theme === "dark" ? "light mode" : "dark mode"}
        </button>
      </header>
      {networkMode === "checking" ? (
        <div className="app-splash">Looking for a server at {serverUrl}…</div>
      ) : (
        <Workspace serverUrl={serverUrl} room={room} networkMode={networkMode} />
      )}
    </div>
  );
}

function Workspace({
  serverUrl,
  room,
  networkMode,
}: {
  serverUrl: string;
  room: string;
  networkMode: "server" | "loopback";
}) {
  const [activeTab, setActiveTab] = useState<TabKey>("collaborate");
  const [paneCount, setPaneCount] = useState(MIN_PANES);
  const [chaos, setChaos] = useState<ChaosConfig>(DEFAULT_CHAOS);
  const [scriptRunning, setScriptRunning] = useState(false);
  const [scriptStep, setScriptStep] = useState(0);

  const identities = useMemo(() => Array.from({ length: PANE_SLOTS }, (_, i) => makePaneIdentity(i)), []);

  const id0 = identities[0];
  const id1 = identities[1];
  const id2 = identities[2];
  const id3 = identities[3];
  if (!id0 || !id1 || !id2 || !id3) throw new Error("pane identities failed to initialize");

  // Fixed arity: useDoc is called exactly PANE_SLOTS times every render,
  // regardless of how many panes are currently visible — "removing" a pane
  // just flips `active` to false so it disconnects without losing its Doc.
  const pane0 = useDoc({ room, replica: id0.replica, name: id0.name, color: colorForIndex(0), networkMode, serverUrl, chaos, active: 0 < paneCount });
  const pane1 = useDoc({ room, replica: id1.replica, name: id1.name, color: colorForIndex(1), networkMode, serverUrl, chaos, active: 1 < paneCount });
  const pane2 = useDoc({ room, replica: id2.replica, name: id2.name, color: colorForIndex(2), networkMode, serverUrl, chaos, active: 2 < paneCount });
  const pane3 = useDoc({ room, replica: id3.replica, name: id3.name, color: colorForIndex(3), networkMode, serverUrl, chaos, active: 3 < paneCount });
  const allPanes = [pane0, pane1, pane2, pane3];
  const visiblePanes = allPanes.slice(0, paneCount);

  const paneMeta = identities.map((id, i) => ({ ...id, color: colorForIndex(i) }));
  const visibleMeta = paneMeta.slice(0, paneCount);

  const togglePartition = useCallback(
    (replica: string) => {
      setChaos((c) => {
        const partitioned = c.partitioned.includes(replica)
          ? c.partitioned.filter((r) => r !== replica)
          : [...c.partitioned, replica];
        return { ...c, partitioned };
      });
    },
    [],
  );

  const runOfflineScript = useCallback(async () => {
    if (scriptRunning) return;
    setScriptRunning(true);
    setActiveTab("chaos");
    const replicaA = id0.replica;
    try {
      // 1/4 — cut Ada's cable and let the "offline" chip render before
      // anyone starts typing, so the moment itself is legible.
      setScriptStep(1);
      setChaos((c) => ({ ...c, partitioned: c.partitioned.includes(replicaA) ? c.partitioned : [...c.partitioned, replicaA] }));
      await sleep(SCRIPT_CUT_SETTLE_MS);

      // 2/4 — both replicas type while Ada is cut off, then the partition is
      // held a while longer so the diverged state stays on screen.
      setScriptStep(2);
      const sentenceA = " Working offline while the cable is cut.";
      const sentenceB = " Meanwhile the rest of the room keeps going.";
      const typeInto = async (doc: (typeof pane0)["doc"], text: string) => {
        for (const ch of text) {
          doc.insert(doc.length, ch);
          await sleep(28 + Math.random() * 32);
        }
      };
      await Promise.all([typeInto(pane0.doc, sentenceA), typeInto(pane1.doc, sentenceB)]);
      await sleep(SCRIPT_OFFLINE_HOLD_MS);

      // 3/4 — heal the partition, then wait for the docs to actually agree
      // (polled against the real CRDT state, not slept for) rather than
      // assume reconnection is instant.
      setScriptStep(3);
      setChaos((c) => ({ ...c, partitioned: c.partitioned.filter((r) => r !== replicaA) }));
      const convergeDeadline = Date.now() + SCRIPT_CONVERGE_TIMEOUT_MS;
      while (pane0.doc.toString() !== pane1.doc.toString() && Date.now() < convergeDeadline) {
        await sleep(SCRIPT_CONVERGE_POLL_MS);
      }

      // 4/4 — converged (or the safety timeout gave up on it); hold it on
      // screen for a beat before handing the button back.
      setScriptStep(4);
      await sleep(SCRIPT_CONVERGED_HOLD_MS);
    } finally {
      setScriptRunning(false);
      setScriptStep(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptRunning, id0.replica, pane0.doc, pane1.doc]);

  const scriptPhase: ChaosScriptPhase | null = scriptPhaseFor(scriptStep, id0.label);

  const canRemove = paneCount > MIN_PANES;
  const canAdd = paneCount < PANE_SLOTS;

  return (
    <div className="workspace">
      {networkMode === "loopback" && (
        <div className="loopback-banner">
          No server found at the configured address — running fully in-browser loopback mode. Every feature works
          identically; nothing leaves this tab.
        </div>
      )}
      <Tabs active={activeTab} onChange={setActiveTab} />

      {activeTab === "collaborate" && (
        <section className="tab-panel">
          <div className="collab-toolbar">
            <PresenceBar entries={visibleMeta.map((m, i) => ({ replica: m.replica, name: m.name, color: m.color, status: visiblePanes[i]?.status ?? "offline" }))} />
            <div className="collab-toolbar-actions">
              <ConvergenceBadge panes={visibleMeta.map((m, i) => ({ replica: m.replica, label: m.label, text: visiblePanes[i]?.text ?? "" }))} />
              <button type="button" className="ghost-btn" disabled={!canAdd} onClick={() => setPaneCount((c) => Math.min(PANE_SLOTS, c + 1))}>
                + add pane
              </button>
            </div>
          </div>
          <div className="pane-grid" data-count={paneCount}>
            {visibleMeta.map((m, i) => {
              const state = visiblePanes[i];
              if (!state) return null;
              return (
                <Pane
                  key={m.id}
                  label={m.label}
                  replica={m.replica}
                  color={m.color}
                  docState={state}
                  removable={canRemove && i === paneCount - 1}
                  onRemove={() => setPaneCount((c) => Math.max(MIN_PANES, c - 1))}
                  onToggleCable={() => togglePartition(m.replica)}
                />
              );
            })}
          </div>
        </section>
      )}

      {activeTab === "chaos" && (
        <section className="tab-panel">
          <ChaosPanel
            chaos={chaos}
            onChange={setChaos}
            panes={visibleMeta.map((m) => ({ replica: m.replica, label: m.label, color: m.color, partitioned: chaos.partitioned.includes(m.replica) }))}
            onTogglePartition={togglePartition}
            onRunScript={runOfflineScript}
            scriptRunning={scriptRunning}
            scriptPhase={scriptPhase}
          />
          <ConvergenceBadge panes={visibleMeta.map((m, i) => ({ replica: m.replica, label: m.label, text: visiblePanes[i]?.text ?? "" }))} />
          <PacketLanes
            lanes={visibleMeta.map((m) => ({ replica: m.replica, label: m.label, color: m.color }))}
            transports={visiblePanes.map((p) => p.transport)}
          />
        </section>
      )}

      {activeTab === "anomaly" && (
        <section className="tab-panel">
          <AnomalyLab sourceDoc={pane0.doc} />
        </section>
      )}
    </div>
  );
}
