/**
 * Fixed 4-color replica palette.
 *
 * Chosen to stay legible on both light and dark backgrounds and to remain
 * distinguishable under protanopia, deuteranopia and tritanopia — no two
 * colors here are separated only by a red/green hue shift the way a
 * red+green pairing would be.
 */
export const REPLICA_PALETTE = [
  "#4C8DFF", // blue
  "#F5A623", // amber
  "#D6409F", // magenta
  "#12B5A6", // teal
] as const;

export type ReplicaColor = (typeof REPLICA_PALETTE)[number];

export function colorForIndex(index: number): string {
  const i = ((index % REPLICA_PALETTE.length) + REPLICA_PALETTE.length) % REPLICA_PALETTE.length;
  return REPLICA_PALETTE[i] ?? REPLICA_PALETTE[0];
}

/** Mix a hex color with the current surface for translucent fills (selections, packet trails). */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
