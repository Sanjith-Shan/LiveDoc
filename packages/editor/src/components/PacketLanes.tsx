import { useEffect, useState } from "react";
import type { PacketEvent, Transport } from "../net/transport";

export interface PacketLane {
  replica: string;
  label: string;
  color: string;
}

interface Dot {
  id: string;
  color: string;
  status: PacketEvent["status"];
  duration: number;
}

/**
 * One horizontal lane per replica. Every outbound packet a transport
 * reports becomes a dot that flies across its sender's lane: red and
 * truncated when dropped, doubled (a ghost twin) when duplicated. Timings
 * are chosen for legibility, not physical accuracy — a 0ms-latency packet
 * still takes ~950ms to cross so the eye can register it.
 */
export function PacketLanes({ lanes, transports }: { lanes: PacketLane[]; transports: Transport[] }) {
  const [dotsByLane, setDotsByLane] = useState<Record<string, Dot[]>>({});

  useEffect(() => {
    const unsubs = transports.map((t) =>
      t.on("packet", (p: PacketEvent) => {
        // A queued packet never leaves, so it barely moves and then holds
        // in place instead of flying across and fading.
        const duration = p.status === "dropped" ? 550 : p.status === "queued" ? 1600 : 950;
        const dot: Dot = { id: p.id, color: laneColor(lanes, p.from), status: p.status, duration };
        setDotsByLane((prev) => {
          const list = prev[p.from] ?? [];
          return { ...prev, [p.from]: [...list, dot] };
        });
        setTimeout(() => {
          setDotsByLane((prev) => {
            const list = prev[p.from];
            if (!list) return prev;
            return { ...prev, [p.from]: list.filter((d) => d.id !== dot.id) };
          });
        }, duration + 200);
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [transports, lanes]);

  return (
    <div className="packet-lanes">
      {lanes.map((lane) => (
        <div key={lane.replica} className="packet-lane">
          <div className="packet-lane-label">
            <span className="packet-lane-dot" style={{ background: lane.color }} />
            {lane.label}
          </div>
          <div className="packet-lane-track">
            {(dotsByLane[lane.replica] ?? []).map((dot) => (
              <span
                key={dot.id}
                className={`packet-dot packet-dot-${dot.status}`}
                style={{ background: dot.color, animationDuration: `${dot.duration}ms` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function laneColor(lanes: PacketLane[], replica: string): string {
  return lanes.find((l) => l.replica === replica)?.color ?? "#888888";
}
