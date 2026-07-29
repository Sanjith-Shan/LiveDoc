const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 8 chars of base36, matching the convention documented for ReplicaID in core. */
export function randomReplicaId(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += BASE36[Math.floor(Math.random() * BASE36.length)];
  }
  return out;
}

const PANE_NAMES = ["Ada", "Bo", "Cleo", "Dov"];

export interface PaneIdentity {
  id: string;
  label: string;
  replica: string;
  name: string;
  colorIndex: number;
}

export function makePaneIdentity(slot: number): PaneIdentity {
  const label = PANE_NAMES[slot % PANE_NAMES.length] ?? `Pane ${slot + 1}`;
  return {
    id: `pane-${slot}`,
    label,
    replica: randomReplicaId(),
    name: label,
    colorIndex: slot,
  };
}
