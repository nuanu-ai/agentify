/**
 * The address money can be sent to on an EVM chain, and its EIP-55 checksum.
 *
 * A character lost or mistyped in an address produces another valid address,
 * and a payment to it is gone. The capital letters a wallet shows are a
 * checksum over the address, so a wrong character stops them agreeing with the
 * digits. Two spellings are accepted: all lower case, which carries no
 * checksum and is what block explorers print, and the exact checksummed form a
 * wallet copies. Anything between the two is refused.
 *
 * The Keccak-256 hash is written out here rather than taken from a package so
 * that the package's runtime dependencies stay zod alone. It is hand-written
 * cryptographic code, kept to the one block an address needs and pinned by the
 * standard's published test vectors; the first other need for a hash in this
 * package is the moment to replace it with an audited library.
 */

import { z } from "zod";

const ADDRESS_LENGTH = 40;

/**
 * An address's shape, as a pattern rather than a refinement so that the JSON
 * Schema export keeps it.
 */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The rate of Keccak-256 in bytes: the state less twice the capacity the
 * 256-bit digest asks for. Forty characters fit in one block.
 */
const BLOCK_BYTES = 136;

/** The constant mixed into the state at the end of each of the twenty-four rounds. */
const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/** How far each lane is rotated as it is carried to its new place. */
const ROTATIONS: readonly number[] = [
  1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44,
];

/** Where each lane goes, following the same path the rotations are read along. */
const DESTINATIONS: readonly number[] = [
  10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1,
];

/** Sixty-four bits, since the arithmetic below is done in unbounded integers. */
const LANE = (1n << 64n) - 1n;

/**
 * One lane of the state by its index. Every index used is inside the
 * twenty-five lanes by construction; the fallback only satisfies the
 * compiler's index check.
 */
const laneAt = (state: readonly bigint[], index: number): bigint => state[index] ?? 0n;

/** One lane rotated left. */
const rotated = (lane: bigint, by: number): bigint =>
  ((lane << BigInt(by)) | (lane >> BigInt(64 - by))) & LANE;

/**
 * The Keccak permutation, applied to the state in place: the column parities,
 * the rotate-and-move, the row mixing, and the round constant.
 */
function permute(state: bigint[]): void {
  for (const constant of ROUND_CONSTANTS) {
    const parity: bigint[] = [];
    for (let column = 0; column < 5; column++) {
      parity[column] =
        laneAt(state, column) ^
        laneAt(state, column + 5) ^
        laneAt(state, column + 10) ^
        laneAt(state, column + 15) ^
        laneAt(state, column + 20);
    }
    for (let column = 0; column < 5; column++) {
      const change =
        laneAt(parity, (column + 4) % 5) ^ rotated(laneAt(parity, (column + 1) % 5), 1);
      for (let row = 0; row < 25; row += 5) {
        state[column + row] = laneAt(state, column + row) ^ change;
      }
    }

    let carried = laneAt(state, 1);
    for (let step = 0; step < 24; step++) {
      const destination = DESTINATIONS[step] ?? 0;
      const held = laneAt(state, destination);
      state[destination] = rotated(carried, ROTATIONS[step] ?? 0);
      carried = held;
    }

    for (let row = 0; row < 25; row += 5) {
      const held = state.slice(row, row + 5);
      for (let column = 0; column < 5; column++) {
        state[row + column] =
          laneAt(held, column) ^
          (~laneAt(held, (column + 1) % 5) & LANE & laneAt(held, (column + 2) % 5));
      }
    }

    state[0] = laneAt(state, 0) ^ constant;
  }
}

/**
 * The first forty hexadecimal digits of the Keccak-256 digest of an address
 * body in lower case, one for each character the checksum reads. The input is
 * always forty ASCII characters, so it is absorbed as one padded block.
 */
function checksumDigits(body: string): string {
  const block = new Uint8Array(BLOCK_BYTES);
  for (let index = 0; index < ADDRESS_LENGTH; index++) {
    block[index] = body.charCodeAt(index);
  }
  // The padding the original Keccak appends: a marker where the message ends,
  // and the top bit of the last byte of the block.
  block[ADDRESS_LENGTH] = 0x01;
  block[BLOCK_BYTES - 1] = 0x80;

  const state = new Array<bigint>(25).fill(0n);
  for (let lane = 0; lane < BLOCK_BYTES / 8; lane++) {
    let value = 0n;
    for (let byte = 7; byte >= 0; byte--) {
      value = (value << 8n) | BigInt(block[lane * 8 + byte] ?? 0);
    }
    state[lane] = value;
  }
  permute(state);

  let digits = "";
  for (let lane = 0; digits.length < ADDRESS_LENGTH; lane++) {
    let value = laneAt(state, lane);
    for (let byte = 0; byte < 8; byte++) {
      digits += (value & 0xffn).toString(16).padStart(2, "0");
      value >>= 8n;
    }
  }
  return digits.slice(0, ADDRESS_LENGTH);
}

/**
 * One address body written the way a wallet writes it: every character whose
 * digest digit is eight or more capitalised, and the rest left alone.
 */
function checksummedBody(body: string): string {
  const digits = checksumDigits(body);
  let written = "";
  for (let index = 0; index < ADDRESS_LENGTH; index++) {
    const character = body[index] ?? "";
    // Capitalising a digit gives it back unchanged, so no letter check is needed.
    written += Number.parseInt(digits[index] ?? "0", 16) >= 8 ? character.toUpperCase() : character;
  }
  return written;
}

/**
 * Whether the letters of this address agree with its checksum. A value of the
 * wrong shape passes here, since the pattern has already refused it and a
 * second complaint would send a merchant looking for a checksum in something
 * that is not an address.
 */
function carriesItsOwnChecksum(value: string): boolean {
  if (!ADDRESS_SHAPE.test(value)) {
    return true;
  }
  const body = value.slice(2);
  const lowered = body.toLowerCase();
  return body === lowered || body === checksummedBody(lowered);
}

/**
 * One address written in the checksummed mixed case a wallet displays, which
 * is the form Agentify stores and returns, because it is the one a person can
 * check by eye against their wallet.
 *
 * Throws on an address of the wrong shape, or one in mixed case whose letters
 * disagree with its checksum, rather than recapitalising it into a
 * well-formed address nobody typed. An address already in this form comes back
 * unchanged.
 */
export function checksummedAddressOf(address: string): string {
  if (!ADDRESS_SHAPE.test(address) || !carriesItsOwnChecksum(address)) {
    throw new Error(
      `${JSON.stringify(address)} is not an address this can write out: it is either not an address at all, or its capital letters disagree with the rest of it`,
    );
  }
  return `0x${checksummedBody(address.slice(2).toLowerCase())}`;
}

/**
 * An address on an EVM chain, all in lower case or in its exact checksummed
 * mixed case. It names no chain: which network a payment is made on is set by
 * the payment requirements, not by the address.
 */
export const EvmAddressSchema = z
  .string()
  .regex(
    ADDRESS_SHAPE,
    "an address on an EVM chain is 0x and then forty hexadecimal characters, with nothing else on it",
  )
  .refine(
    carriesItsOwnChecksum,
    "this address has a mistyped character: its capital letters are a checksum, and they do not" +
      " match the rest of it; copy the address again from your wallet and paste it whole",
  )
  .meta({
    description:
      "An address on an EVM chain: 0x and forty hexadecimal characters. Two spellings are accepted and no others — all in lower case, which carries no checksum, and the exact mixed-case spelling a wallet shows, which is the EIP-55 checksum of the address. Anything between the two is refused, because the capitals are a checksum and letters that disagree with the digits mean a character is wrong; an address that is wrong is another perfectly valid address belonging to somebody else. That checksum is not part of this document: JSON Schema cannot express it, so a client generated from here checks the shape and this gateway checks the rest. What is stored and what comes back is always the mixed-case spelling a wallet shows, whichever of the two was sent — it is the form a person can recognise at a glance, which on the one field money is sent to is the whole of the checking anybody does.",
  });

export type EvmAddress = z.infer<typeof EvmAddressSchema>;
