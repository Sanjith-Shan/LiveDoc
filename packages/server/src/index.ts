import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { Room } from "./room.js";
import type { ClientMessage } from "./protocol.js";

const DEFAULT_PORT = 8787;
const HEARTBEAT_MS = 30_000;

export interface ServerHandle {
  wss: WebSocketServer;
  close: () => Promise<void>;
}

/** Wires up the relay: room registry, join/message/close routing, heartbeat.
 * Exported (rather than only run as a script) so tests can start it on an
 * ephemeral port with real `ws` client sockets. */
export function startServer(port: number = DEFAULT_PORT): ServerHandle {
  const rooms = new Map<string, Room>();
  const identities = new WeakMap<WebSocket, { room: string; replica: string }>();
  const alive = new WeakMap<WebSocket, boolean>();

  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    ws.on("message", (raw: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // malformed JSON; never crash the relay over a bad frame
      }
      if (typeof msg !== "object" || msg === null || typeof (msg as { t?: unknown }).t !== "string") {
        return; // unrecognized shape; ignore
      }

      if (msg.t === "join") {
        const { room: roomName, replica, name, color } = msg;
        if (!roomName || !replica) return;
        let room = rooms.get(roomName);
        if (!room) {
          room = new Room(roomName);
          rooms.set(roomName, room);
        }
        identities.set(ws, { room: roomName, replica });
        room.join(ws, replica, name ?? replica, color ?? "#888888");
        return;
      }

      // Any other message type before a successful join has no identity
      // to route under yet; drop it instead of guessing.
      const identity = identities.get(ws);
      if (!identity) return;
      rooms.get(identity.room)?.handleMessage(identity.replica, msg);
    });

    ws.on("close", () => {
      const identity = identities.get(ws);
      if (!identity) return;
      const room = rooms.get(identity.room);
      room?.leave(identity.replica);
      if (room?.isEmpty) {
        room.dispose();
        rooms.delete(identity.room);
      }
    });

    ws.on("error", () => {
      // The 'close' event follows and does the actual peer cleanup.
    });
  });

  // Terminate sockets that stop answering pings (e.g. a client that vanished
  // without a clean close), so a room doesn't hold a dead peer forever.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on("close", () => clearInterval(heartbeat));

  return {
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        for (const room of rooms.values()) room.dispose();
        for (const client of wss.clients) client.terminate();
        wss.close(() => resolve());
      }),
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  startServer(port);
  console.log(`weave relay listening on ws://localhost:${port}`);
}
