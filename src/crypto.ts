/**
 * Client-side commitment / nullifier derivation.
 *
 * These MUST match the hashing the Compact contract performs, so we reuse the
 * exact same runtime primitive (`persistentHash`) and the exact same Compact
 * type descriptors the compiler emits. Because both sides call the identical
 * function with identical type descriptors, the digests are guaranteed to agree.
 */
import {
  persistentHash,
  CompactTypeBytes,
  CompactTypeVector,
  CompactTypeUnsignedInteger,
} from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const BYTES32 = new CompactTypeBytes(32);
const VEC2_BYTES32 = new CompactTypeVector(2, BYTES32);
// Uint<64> as the contract sees it: max value 2^64 - 1, 8 bytes wide.
const UINT64 = new CompactTypeUnsignedInteger((1n << 64n) - 1n, 8);

export type Hex = string;

export function toHex(b: Uint8Array): Hex {
  return '0x' + Buffer.from(b).toString('hex');
}

export function fromHex(h: Hex): Uint8Array {
  return Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
}

/** 32 random bytes, used for pledge secrets and campaign salts. */
export function randomBytes32(): Uint8Array {
  return Uint8Array.from(randomBytes(32));
}

/**
 * Hash an arbitrary UTF-8 string down to a Bytes<32>. Used to turn a
 * human-readable target ("Report manager Dana Reeves") into the opaque 32-byte
 * value the contract works with. Padded/truncated to 32 bytes then hashed so
 * the domain is the full string, not just its first 32 bytes.
 */
export function targetToBytes32(target: string): Uint8Array {
  const utf8 = new TextEncoder().encode(target);
  // Fold arbitrary-length input into 32 bytes via persistentHash over a 32-byte
  // chunked representation. We hash the first 32-byte block XOR-folded with the
  // rest to keep it dependent on the whole string.
  const acc = new Uint8Array(32);
  for (let i = 0; i < utf8.length; i++) acc[i % 32] ^= utf8[i];
  return persistentHash(BYTES32, acc);
}

/**
 * Pledge commitment = H(secret, target). Reveals nothing about the pledger or
 * the target on its own.
 */
export function pledgeCommitment(secret: Uint8Array, target: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [secret, target]);
}

/**
 * Nullifier = H(secret) — a per-pledge distinctness tag that does not link back
 * to identity. Matches the contract's `persistentHash<Bytes<32>>(secret)`.
 */
export function nullifier(secret: Uint8Array): Uint8Array {
  return persistentHash(BYTES32, secret);
}

/** Salted target commitment stored on-chain at campaign creation. */
export function targetCommitment(target: Uint8Array, salt: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [target, salt]);
}

/** Pack a Uint<64> into Bytes<32> exactly as the contract's numToBytes does. */
export function numToBytes(n: bigint): Uint8Array {
  return persistentHash(UINT64, n);
}

/** Salted threshold commitment stored on-chain at campaign creation. */
export function thresholdCommitment(threshold: bigint, salt: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [numToBytes(threshold), salt]);
}
