import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Awareness, Doc } from "@weave/core";
import type { Algorithm, PeerState } from "@weave/core";
import {
  ChaosConfig,
  ConnectionStatus,
  Transport,
  TransportIdentity,
  createTransport,
} from "../net/transport";
import { diffRange } from "../lib/diff";

export interface UseDocOptions {
  room: string;
  replica: string;
  name: string;
  color: string;
  algorithm?: Algorithm;
  networkMode: "server" | "loopback";
  serverUrl: string;
  chaos: ChaosConfig;
  /** When false, the pane stays fully constructed but disconnected — used for "removed" panes. */
  active: boolean;
}

export interface UseDocResult {
  doc: InstanceType<typeof Doc>;
  awareness: InstanceType<typeof Awareness>;
  text: string;
  status: ConnectionStatus;
  peers: PeerState[];
  /** Derived from chaos.partitioned — this pane's own replica id is cut off. */
  partitioned: boolean;
  usingLoopback: boolean;
  applyLocalEdit: (nextValue: string) => void;
  setCursor: (start: number, end: number) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  transport: Transport;
}

/** Binds one CRDT `Doc` (+ its `Awareness` + transport) to React state. */
export function useDoc(opts: UseDocOptions): UseDocResult {
  const docRef = useRef<InstanceType<typeof Doc> | null>(null);
  if (!docRef.current) {
    docRef.current = new Doc({ replica: opts.replica });
  }
  const doc = docRef.current;

  const awarenessRef = useRef<InstanceType<typeof Awareness> | null>(null);
  if (!awarenessRef.current) {
    awarenessRef.current = new Awareness(doc);
  }
  const awareness = awarenessRef.current;

  const undoManagerRef = useRef(doc.undoManager());

  const identity: TransportIdentity = useMemo(
    () => ({ room: opts.room, replica: opts.replica, name: opts.name, color: opts.color }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [opts.room, opts.replica],
  );

  const transportRef = useRef<Transport | null>(null);
  if (!transportRef.current) {
    transportRef.current = createTransport(
      opts.networkMode,
      opts.serverUrl,
      identity,
      opts.algorithm ?? "fugue",
      () => doc.stateVector(),
    );
  }
  const transport = transportRef.current;

  const [text, setText] = useState(() => doc.toString());
  const [status, setStatus] = useState<ConnectionStatus>("reconnecting");
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [, bumpUndo] = useState(0);

  // The chaos config's `partitioned` list is the single source of truth for
  // "cut the cable" — this pane is offline exactly when its own replica id
  // is in that list, whether the toggle came from the Chaos tab or a pane
  // header. Not local state, so the two can never disagree.
  const partitioned = opts.chaos.partitioned.includes(opts.replica);

  useEffect(() => {
    awareness.setLocal({ name: opts.name, color: opts.color });
  }, [awareness, opts.name, opts.color]);

  useEffect(() => {
    if (!opts.active) return;

    const offUpdate = doc.on("update", (u: Uint8Array) => transport.sendUpdate(u));
    const offChange = doc.on("change", () => {
      setText(doc.toString());
      bumpUndo((t) => t + 1);
    });
    const offAwarenessChange = awareness.on("change", () => {
      transport.sendAwareness(awareness.encode());
      setPeers(awareness.peers());
    });

    const offStatus = transport.on("status", setStatus);
    const offWelcome = transport.on("welcome", () => setPeers(awareness.peers()));
    const offPeers = transport.on("peers", () => setPeers(awareness.peers()));
    const offRemoteUpdate = transport.on("update", ({ update }) => doc.applyUpdate(update));
    const offRemoteAwareness = transport.on("awareness", ({ data }) => {
      awareness.applyRemote(data);
      setPeers(awareness.peers());
    });

    transport.connect();
    transport.sendAwareness(awareness.encode());

    return () => {
      offUpdate();
      offChange();
      offAwarenessChange();
      offStatus();
      offWelcome();
      offPeers();
      offRemoteUpdate();
      offRemoteAwareness();
      transport.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, awareness, transport, opts.active]);

  useEffect(() => {
    transport.setChaos(opts.chaos);
  }, [transport, opts.chaos]);

  useEffect(() => {
    transport.setPartitioned(partitioned);
  }, [transport, partitioned]);

  const applyLocalEdit = useCallback(
    (nextValue: string) => {
      const prev = doc.toString();
      if (prev === nextValue) return;
      const [start, oldEnd, newEnd] = diffRange(prev, nextValue);
      if (oldEnd > start) doc.delete(start, oldEnd - start);
      if (newEnd > start) doc.insert(start, nextValue.slice(start, newEnd));
    },
    [doc],
  );

  const setCursor = useCallback(
    (start: number, end: number) => {
      awareness.setCursor(start, end);
    },
    [awareness],
  );

  const undo = useCallback(() => {
    undoManagerRef.current.undo();
  }, []);
  const redo = useCallback(() => {
    undoManagerRef.current.redo();
  }, []);

  return {
    doc,
    awareness,
    text,
    status,
    peers,
    partitioned,
    usingLoopback: opts.networkMode === "loopback",
    applyLocalEdit,
    setCursor,
    undo,
    redo,
    canUndo: undoManagerRef.current.canUndo,
    canRedo: undoManagerRef.current.canRedo,
    transport,
  };
}
