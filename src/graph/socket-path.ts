/**
 * Compute a deterministic IPC socket path for a given graph directory.
 *
 * On POSIX this is just `<graphDir>/graph.sock`. The file is short-lived —
 * the leader unlinks it on exit, and a stale file is cleaned up by
 * `startIpcServer` on next boot.
 *
 * On Windows, Unix domain socket paths are problematic (path length limits,
 * AF_UNIX support is recent). Node supports named pipes via the same
 * `net.createServer().listen(path)` API when the path has the magic prefix
 * `\\.\pipe\...`. Since named pipes live in a global namespace, we hash the
 * graph directory to produce a collision-resistant unique name per
 * (projectId, cwd).
 */

import { join } from "path";
import { createHash } from "crypto";

export function graphSocketPath(graphDir: string): string {
  if (process.platform === "win32") {
    const hash = createHash("sha256").update(graphDir).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\opencode-graph-${hash}`;
  }
  // Unix socket paths are limited to ~104 bytes on macOS / ~108 on Linux
  // (sun_path). `<graphDir>/graph.sock` easily fits for typical cache paths
  // under ~/Library/Application Support or $XDG_DATA_HOME. If a caller
  // provides an unusually long graphDir, they'll get an EADDRNOTAVAIL /
  // ENAMETOOLONG from bind — acceptable failure, surfaced by the caller.
  return join(graphDir, "graph.sock");
}
