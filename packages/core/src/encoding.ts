/**
 * Compact binary encoding for updates and snapshots.
 *
 * Two decisions carry most of the win:
 *   - LEB128 varints, so small counters cost one byte;
 *   - a per-message replica table, so a replica id is written once and
 *     referenced by index afterwards.
 *
 * The result is measured against Yjs's `lib0` encoding in packages/bench
 * (suite: wire size). Yjs wins; the gap is reported rather than hidden.
 */
export class Encoder {
  private buf: Uint8Array;
  private len = 0;

  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
  }

  private grow(need: number): void {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): void {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
  }

  /** LEB128, unsigned. */
  varint(v: number): void {
    if (v < 0 || !Number.isInteger(v)) throw new RangeError(`varint expects a non-negative integer, got ${v}`);
    this.grow(10);
    let n = v;
    while (n > 0x7f) {
      this.buf[this.len++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.len++] = n;
  }

  /** Zig-zag then LEB128, for values that may be negative. */
  svarint(v: number): void {
    this.varint(v < 0 ? -v * 2 - 1 : v * 2);
  }

  string(s: string): void {
    const bytes = TEXT_ENCODER.encode(s);
    this.varint(bytes.length);
    this.grow(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  bytes(b: Uint8Array): void {
    this.varint(b.length);
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  get length(): number {
    return this.len;
  }
}

export class Decoder {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  u8(): number {
    if (this.pos >= this.buf.length) throw new RangeError("Decoder: read past end");
    return this.buf[this.pos++]!;
  }

  varint(): number {
    let out = 0;
    let shift = 1;
    for (;;) {
      const b = this.u8();
      out += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) return out;
      shift *= 128;
      if (shift > 2 ** 53) throw new RangeError("Decoder: varint overflow");
    }
  }

  svarint(): number {
    const v = this.varint();
    return v % 2 === 1 ? -(v + 1) / 2 : v / 2;
  }

  string(): string {
    const n = this.varint();
    const s = TEXT_DECODER.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  bytes(): Uint8Array {
    const n = this.varint();
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Interns replica ids so each one is written once per message and referenced
 * by a small integer thereafter.
 */
export class ReplicaTable {
  private readonly toIdx = new Map<string, number>();
  private readonly list: string[] = [];

  index(r: string): number {
    const found = this.toIdx.get(r);
    if (found !== undefined) return found;
    const i = this.list.length;
    this.list.push(r);
    this.toIdx.set(r, i);
    return i;
  }

  at(i: number): string {
    const r = this.list[i];
    if (r === undefined) throw new RangeError(`ReplicaTable: no replica at index ${i}`);
    return r;
  }

  write(enc: Encoder): void {
    enc.varint(this.list.length);
    for (const r of this.list) enc.string(r);
  }

  static read(dec: Decoder): ReplicaTable {
    const t = new ReplicaTable();
    const n = dec.varint();
    for (let i = 0; i < n; i++) t.index(dec.string());
    return t;
  }
}
