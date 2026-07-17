import { describe, it, expect, beforeEach, afterEach } from "vitest";
import WebSocket, { type RawData } from "ws";
import type { AddressInfo } from "node:net";
import { startServer, type ServerHandle } from "../src/index.js";
import { encodeBase64 } from "../src/protocol.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;

let handle: ServerHandle;
let port: number;

beforeEach(async () => {
  handle = startServer(0); // ephemeral port
  await new Promise<void>((resolve) => handle.wss.once("listening", resolve));
  port = (handle.wss.address() as AddressInfo).port;
});

afterEach(async () => {
  await handle.close();
});

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function join(ws: WebSocket, room: string, replica: string): void {
  ws.send(JSON.stringify({ t: "join", room, replica, name: replica, color: "#000000" }));
}

/** Resolves with the next message matching `match` (default: any message). */
function nextMessage(ws: WebSocket, match?: (m: AnyMsg) => boolean): Promise<AnyMsg> {
  return new Promise((resolve) => {
    const handler = (raw: RawData) => {
      const msg = JSON.parse(raw.toString());
      if (!match || match(msg)) {
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

const payload = encodeBase64(new TextEncoder().encode("hello-update"));

describe("relay", () => {
  it("relays an update from one client to another", async () => {
    const alice = await connect();
    const bob = await connect();
    join(alice, "room-1", "alice");
    await nextMessage(alice, (m) => m.t === "welcome");
    join(bob, "room-1", "bob");
    await nextMessage(bob, (m) => m.t === "welcome");

    const received = nextMessage(bob, (m) => m.t === "update");
    alice.send(JSON.stringify({ t: "update", d: payload }));
    const msg = await received;

    expect(msg).toMatchObject({ t: "update", d: payload, from: "alice" });
    expect(typeof msg.seq).toBe("number");

    alice.close();
    bob.close();
  });

  it("drops delivery to a partitioned client and lets it catch up via resume after healing", async () => {
    const alice = await connect();
    const bob = await connect();
    join(alice, "room-2", "alice");
    await nextMessage(alice, (m) => m.t === "welcome");
    join(bob, "room-2", "bob");
    await nextMessage(bob, (m) => m.t === "welcome");

    // Partition bob.
    alice.send(JSON.stringify({ t: "chaos", cfg: { partitioned: ["bob"] } }));
    await nextMessage(alice, (m) => m.t === "chaos");

    let bobSawUpdate = false;
    const watcher = (raw: RawData) => {
      if (JSON.parse(raw.toString()).t === "update") bobSawUpdate = true;
    };
    bob.on("message", watcher);

    alice.send(JSON.stringify({ t: "update", d: payload }));
    await new Promise((r) => setTimeout(r, 100));
    expect(bobSawUpdate).toBe(false);
    bob.off("message", watcher);

    // Heal the partition.
    alice.send(JSON.stringify({ t: "chaos", cfg: { partitioned: [] } }));
    await nextMessage(alice, (m) => m.t === "chaos");

    // Bob resumes from seq 0 and gets everything relayed while it was gone --
    // this is the state-vector-exchange recovery path (a real client would
    // send `sv` and a peer would answer; `resume` replays the same ring
    // buffer directly using the seq the client last saw).
    const caughtUp = nextMessage(bob, (m) => m.t === "update");
    bob.send(JSON.stringify({ t: "resume", seq: 0 }));
    const msg = await caughtUp;
    expect(msg.d).toBe(payload);
    expect(msg.from).toBe("alice");

    alice.close();
    bob.close();
  });

  it("does not crash the relay when a message is duplicated", async () => {
    const alice = await connect();
    const bob = await connect();
    join(alice, "room-3", "alice");
    await nextMessage(alice, (m) => m.t === "welcome");
    join(bob, "room-3", "bob");
    await nextMessage(bob, (m) => m.t === "welcome");

    const updates: AnyMsg[] = [];
    bob.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === "update") updates.push(m);
    });

    // Two literal sends of the identical payload (a duplicate delivery from
    // the network's point of view, or a client that has not deduped yet).
    alice.send(JSON.stringify({ t: "update", d: payload }));
    alice.send(JSON.stringify({ t: "update", d: payload }));
    await new Promise((r) => setTimeout(r, 100));

    expect(updates.length).toBe(2);
    expect(updates.every((m) => m.d === payload)).toBe(true);

    // The relay must still be alive and serving traffic afterwards.
    const again = nextMessage(bob, (m) => m.t === "update");
    alice.send(JSON.stringify({ t: "update", d: payload }));
    await expect(again).resolves.toMatchObject({ d: payload });

    alice.close();
    bob.close();
  });

  it("broadcasts awareness to peers but not back to the sender", async () => {
    const alice = await connect();
    const bob = await connect();
    join(alice, "room-4", "alice");
    await nextMessage(alice, (m) => m.t === "welcome");
    join(bob, "room-4", "bob");
    await nextMessage(bob, (m) => m.t === "welcome");

    let aliceSawAwareness = false;
    const watcher = (raw: RawData) => {
      if (JSON.parse(raw.toString()).t === "awareness") aliceSawAwareness = true;
    };
    alice.on("message", watcher);

    const bobGets = nextMessage(bob, (m) => m.t === "awareness");
    alice.send(JSON.stringify({ t: "awareness", d: payload }));
    const msg = await bobGets;
    expect(msg).toMatchObject({ t: "awareness", d: payload, from: "alice" });

    await new Promise((r) => setTimeout(r, 50));
    expect(aliceSawAwareness).toBe(false);

    alice.close();
    bob.close();
  });

  it("removes a disconnected peer from the broadcast peer list", async () => {
    const alice = await connect();
    const bob = await connect();
    join(alice, "room-5", "alice");
    await nextMessage(alice, (m) => m.t === "welcome");
    // Alice will see a "peers" broadcast for bob joining too; drain that one
    // first so the next listener catches the one from bob *leaving*.
    const joinPeers = nextMessage(alice, (m) => m.t === "peers");
    join(bob, "room-5", "bob");
    const welcomeBob = await nextMessage(bob, (m) => m.t === "welcome");
    expect(welcomeBob.peers.map((p: AnyMsg) => p.replica).sort()).toEqual(["alice", "bob"]);
    await joinPeers;

    const peersUpdate = nextMessage(alice, (m) => m.t === "peers");
    bob.close();
    const msg = await peersUpdate;
    expect(msg.peers.map((p: AnyMsg) => p.replica)).toEqual(["alice"]);

    alice.close();
  });
});
