/**
 * DataChannel message framing.
 *
 * RTCDataChannels cap message size (16KB–256KB, browser-dependent), but an
 * initial CRDT catch-up can be far larger. We split big frames into <=15KB
 * chunks and reassemble on the far side. Small frames pay a single flag byte.
 *
 *   single  : [0x00] [payload…]
 *   chunked : [0x01] [msgId u32] [index u16] [total u16] [payload…]
 *
 * Lifted, trimmed, from apps/web's WebRTC adapter — proven framing.
 */

const MAX_CHUNK_PAYLOAD = 15 * 1024;
const FLAG_SINGLE = 0x00;
const FLAG_CHUNKED = 0x01;
const CHUNK_HEADER_SIZE = 9; // 1 flag + 4 msgId + 2 index + 2 total

export function chunkMessage(data: Uint8Array, msgId: number): Uint8Array[] {
  if (data.byteLength <= MAX_CHUNK_PAYLOAD) {
    const frame = new Uint8Array(1 + data.byteLength);
    frame[0] = FLAG_SINGLE;
    frame.set(data, 1);
    return [frame];
  }

  const total = Math.ceil(data.byteLength / MAX_CHUNK_PAYLOAD);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const start = i * MAX_CHUNK_PAYLOAD;
    const payload = data.subarray(start, Math.min(start + MAX_CHUNK_PAYLOAD, data.byteLength));
    const frame = new Uint8Array(CHUNK_HEADER_SIZE + payload.byteLength);
    const view = new DataView(frame.buffer);
    frame[0] = FLAG_CHUNKED;
    view.setUint32(1, msgId >>> 0);
    view.setUint16(5, i);
    view.setUint16(7, total);
    frame.set(payload, CHUNK_HEADER_SIZE);
    chunks.push(frame);
  }
  return chunks;
}

/** Reassembles incoming frames from one peer. */
export class ChunkAssembler {
  private pending = new Map<
    number,
    { chunks: (Uint8Array | null)[]; received: number; totalSize: number }
  >();

  /** Returns the full message once complete, else null while waiting. */
  process(frame: Uint8Array): Uint8Array | null {
    if (frame[0] === FLAG_SINGLE) return frame.subarray(1);

    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const msgId = view.getUint32(1);
    const index = view.getUint16(5);
    const total = view.getUint16(7);
    const payload = frame.subarray(CHUNK_HEADER_SIZE);

    let entry = this.pending.get(msgId);
    if (!entry) {
      entry = { chunks: new Array<Uint8Array | null>(total).fill(null), received: 0, totalSize: 0 };
      this.pending.set(msgId, entry);
    }
    if (entry.chunks[index] === null) {
      entry.chunks[index] = payload;
      entry.received++;
      entry.totalSize += payload.byteLength;
    }
    if (entry.received < total) return null;

    this.pending.delete(msgId);
    const out = new Uint8Array(entry.totalSize);
    let offset = 0;
    for (const chunk of entry.chunks) {
      out.set(chunk as Uint8Array, offset);
      offset += (chunk as Uint8Array).byteLength;
    }
    return out;
  }

  clear(): void {
    this.pending.clear();
  }
}
