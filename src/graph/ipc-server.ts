/**
 * Leader-side IPC server. Accepts follower connections over a Unix socket
 * (or Windows named pipe), performs the version handshake, pipes RPC
 * payloads to an `RpcServer`, and responds to heartbeats.
 *
 * Multiple followers may be connected at once; each connection gets its
 * own FrameDecoder + heartbeat watchdog. RpcServer is stateless w.r.t.
 * connections — the server just routes responses back on the connection
 * the call arrived on.
 */

import net from "net";
import { existsSync, unlinkSync } from "fs";
import { FrameDecoder } from "./ipc-framing";
import { encodeFrame } from "./ipc-framing";
import {
  GRAPH_IPC_VERSION,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type IpcMessage,
} from "./ipc-transport";
import type { RpcServer } from "./rpc";

export interface IpcServerOptions {
  socketPath: string;
  rpcServer: RpcServer;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  logger?: { error?: (msg: string, err?: unknown) => void; debug?: (msg: string) => void };
}

export interface IpcServer {
  readonly socketPath: string;
  readonly connectionCount: number;
  close(): Promise<void>;
}

interface ActiveConnection {
  socket: net.Socket;
  decoder: FrameDecoder;
  handshakeDone: boolean;
  lastPingAt: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

export function startIpcServer(opts: IpcServerOptions): Promise<IpcServer> {
  const { socketPath, rpcServer, logger } = opts;
  const interval = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const timeout = opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;

  // Defensive cleanup: a stale socket file can linger from a hard crash.
  // On Windows named pipes this is a no-op.
  if (!socketPath.startsWith("\\\\.\\pipe\\") && existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch (err) {
      logger?.debug?.(`startIpcServer: could not unlink stale socket ${socketPath}: ${(err as Error).message}`);
    }
  }

  const connections = new Set<ActiveConnection>();

  const server = net.createServer((socket) => {
    const conn: ActiveConnection = {
      socket,
      decoder: new FrameDecoder(),
      handshakeDone: false,
      lastPingAt: Date.now(),
      heartbeatTimer: null,
    };
    connections.add(conn);

    const closeConn = (reason?: string) => {
      if (conn.heartbeatTimer) {
        clearInterval(conn.heartbeatTimer);
        conn.heartbeatTimer = null;
      }
      try {
        socket.end();
        socket.destroy();
      } catch {
        /* ignore */
      }
      connections.delete(conn);
      if (reason) logger?.debug?.(`ipc-server: connection closed: ${reason}`);
    };

    const writeMsg = (msg: IpcMessage) => {
      try {
        socket.write(encodeFrame(msg));
      } catch (err) {
        logger?.debug?.(`ipc-server: write failed: ${(err as Error).message}`);
        closeConn("write failed");
      }
    };

    socket.on("error", (err) => {
      logger?.debug?.(`ipc-server: socket error: ${err.message}`);
      closeConn("socket error");
    });
    socket.on("close", () => closeConn());

    socket.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = Array.from(conn.decoder.push(chunk));
      } catch (err) {
        logger?.error?.("ipc-server: decoder error", err);
        closeConn("decoder error");
        return;
      }

      for (const raw of messages) {
        const msg = raw as IpcMessage;
        if (!conn.handshakeDone) {
          if (msg?.kind !== "hello" || msg.role !== "client") {
            writeMsg({ kind: "hello", version: GRAPH_IPC_VERSION, role: "server", accepted: false, reason: "expected client hello" });
            closeConn("bad handshake");
            return;
          }
          if (msg.version !== GRAPH_IPC_VERSION) {
            writeMsg({
              kind: "hello",
              version: GRAPH_IPC_VERSION,
              role: "server",
              accepted: false,
              reason: `version mismatch: expected ${GRAPH_IPC_VERSION}, got ${msg.version}`,
            });
            closeConn("version mismatch");
            return;
          }
          conn.handshakeDone = true;
          writeMsg({ kind: "hello", version: GRAPH_IPC_VERSION, role: "server", accepted: true });

          conn.heartbeatTimer = setInterval(() => {
            if (Date.now() - conn.lastPingAt > timeout) {
              logger?.debug?.("ipc-server: heartbeat timeout, closing connection");
              closeConn("heartbeat timeout");
              return;
            }
            writeMsg({ kind: "ping", t: Date.now() });
          }, interval);
          (conn.heartbeatTimer as any).unref?.();
          continue;
        }

        switch (msg?.kind) {
          case "ping":
            conn.lastPingAt = Date.now();
            writeMsg({ kind: "pong", t: msg.t });
            break;
          case "pong":
            conn.lastPingAt = Date.now();
            break;
          case "rpc":
            // Hand RPC payload to the shared RpcServer; it calls back with
            // a response that we wrap in an rpc frame and send.
            void rpcServer.handle(msg.payload, (response) => {
              writeMsg({ kind: "rpc", payload: response });
            });
            break;
          default:
            logger?.debug?.(`ipc-server: dropping unknown message kind=${(msg as any)?.kind}`);
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve({
        socketPath,
        get connectionCount() {
          return connections.size;
        },
        close: () =>
          new Promise<void>((closeResolve) => {
            for (const conn of connections) {
              if (conn.heartbeatTimer) clearInterval(conn.heartbeatTimer);
              try {
                // Send goodbye so followers can fail over immediately
                // instead of waiting for the heartbeat interval. Bun's
                // UDS 'close' event doesn't always fire on peer destroy,
                // so this message is our only reliable signal.
                conn.socket.write(encodeFrame({ kind: "goodbye", reason: "leader shutting down" }));
              } catch {
                /* ignore */
              }
              try {
                conn.socket.end();
                conn.socket.destroy();
              } catch {
                /* ignore */
              }
            }
            connections.clear();
            server.close(() => {
              if (!socketPath.startsWith("\\\\.\\pipe\\") && existsSync(socketPath)) {
                try {
                  unlinkSync(socketPath);
                } catch {
                  /* ignore */
                }
              }
              closeResolve();
            });
          }),
      });
    });
  });
}
