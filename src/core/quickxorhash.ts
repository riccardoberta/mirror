/**
 * QuickXorHash — the non-cryptographic hash OneDrive uses for `file.hashes.quickXorHash`.
 * It is the only hash guaranteed to be present on both OneDrive for Business and OneDrive personal.
 *
 * Algorithm (Microsoft, "QuickXorHash" code snippet): every input byte i is placed in a 160-bit
 * block rotated left by (i * 11) mod 160 bits and XORed into the accumulator; finally the input
 * length (64-bit little-endian) is XORed into the last 8 bytes. Output: 20 bytes, base64-encoded.
 *
 * This implementation follows the fast formulation used by rclone (ported from namazso/QuickXorHash,
 * BSD Zero Clause License): bytes are XORed cyclically into an 11*160 = 1760-byte buffer and the
 * rotations are applied once at the end. Verified against rclone's published test vectors (see tests).
 */

const SIZE = 20;
const SHIFT = 11;
const WIDTH_IN_BITS = 8 * SIZE; // 160
const DATA_SIZE = SHIFT * WIDTH_IN_BITS; // 1760

export class QuickXorHash {
  private readonly data = new Uint8Array(DATA_SIZE);
  private size = 0; // total bytes processed (fits in double precisely up to 2^53)

  update(chunk: Uint8Array): this {
    const data = this.data;
    let pos = this.size % DATA_SIZE;
    for (let i = 0; i < chunk.length; i++) {
      data[pos] = data[pos]! ^ chunk[i]!;
      pos++;
      if (pos === DATA_SIZE) pos = 0;
    }
    this.size += chunk.length;
    return this;
  }

  /** Returns the 20-byte digest. Does not reset the state. */
  digest(): Uint8Array {
    const h = new Uint8Array(SIZE + 1);
    const data = this.data;
    for (let i = 0; i < DATA_SIZE; i++) {
      const shift = (i * SHIFT) % WIDTH_IN_BITS;
      const shiftBytes = shift >>> 3;
      const shiftBits = shift & 7;
      const shifted = data[i]! << shiftBits;
      h[shiftBytes] = h[shiftBytes]! ^ (shifted & 0xff);
      h[shiftBytes + 1] = h[shiftBytes + 1]! ^ ((shifted >>> 8) & 0xff);
    }
    h[0] = h[0]! ^ h[SIZE]!;

    // XOR the length, little-endian, into the last 8 bytes.
    let len = this.size;
    for (let b = 0; b < 8; b++) {
      h[SIZE - 8 + b] = h[SIZE - 8 + b]! ^ len % 256;
      len = Math.floor(len / 256);
    }
    return h.subarray(0, SIZE);
  }

  digestBase64(): string {
    return Buffer.from(this.digest()).toString('base64');
  }

  static ofBuffer(buf: Uint8Array): string {
    return new QuickXorHash().update(buf).digestBase64();
  }
}
