/**
 * Length-prefixed JSON framing for stream transports (Unix socket, named pipe).
 *
 * Wire format:
 *   [4 bytes big-endian uint32 body length] [UTF-8 JSON body]
 *
 * The 4-byte prefix excludes itself. Max body length is capped to avoid
 * unbounded memory growth on malformed / hostile input.
 */

export const MAX_FRAME_BYTES = 64 * 1024 * 1024; // 64 MiB hard cap per frame

export function encodeFrame(message: unknown): Buffer {
  const json = JSON.stringify(message);
  const body = Buffer.from(json, "utf8");
  if (body.length > MAX_FRAME_BYTES) {
    throw new Error(`encodeFrame: body exceeds MAX_FRAME_BYTES (${body.length} > ${MAX_FRAME_BYTES})`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Streaming decoder that buffers partial chunks and emits complete frames.
 *
 * Usage:
 *   const dec = new FrameDecoder()
 *   socket.on('data', chunk => {
 *     for (const msg of dec.push(chunk)) handle(msg)
 *   })
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private expected: number | null = null;

  /** Push a chunk and yield any complete decoded messages. */
  *push(chunk: Buffer): Generator<unknown, void, void> {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.expected === null) {
        if (this.buffer.length < 4) return;
        this.expected = this.buffer.readUInt32BE(0);
        if (this.expected > MAX_FRAME_BYTES) {
          // Protect against allocations driven by garbage input.
          throw new Error(`FrameDecoder: frame length ${this.expected} exceeds MAX_FRAME_BYTES`);
        }
        this.buffer = this.buffer.subarray(4);
      }
      if (this.buffer.length < this.expected) return;
      const body = this.buffer.subarray(0, this.expected);
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString("utf8"));
      } catch (err) {
        throw new Error(`FrameDecoder: invalid JSON frame: ${(err as Error).message}`);
      }
      yield parsed;
    }
  }

  /** Reset decoder state (e.g. after socket reconnect). */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.expected = null;
  }

  /** Number of bytes currently buffered but not yet a complete frame. */
  get buffered(): number {
    return this.buffer.length;
  }
}
