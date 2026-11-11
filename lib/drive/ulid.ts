// ULIDs for Drive ids: a 48-bit millisecond timestamp then 80 bits of
// randomness, in Crockford base32 (I, L, O and U left out so an id cannot be
// misread as 1 or 0). Lexicographic order is time order, which is what lets a
// version list sort by id and a cursor stay stable.
//
// The generator is monotonic within one millisecond: a second id in the same
// millisecond is the previous one plus one, so two rows written in the same
// tick still order deterministically rather than by luck. That matters because
// a version's id is its tiebreak against everything else in the table.
//
// Dependency-free and I/O-free, so it runs as plain source under node:test.

/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LENGTH = 10
const RANDOM_LENGTH = 16
/** 2^48 - 1: the largest millisecond a 48-bit timestamp can carry. */
const MAX_TIME = 2 ** 48 - 1

function encodeRandom(bytes: Uint8Array): string {
  // 80 bits as 16 base32 characters: each character carries 5 bits.
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  let out = ''
  for (let index = 0; index < RANDOM_LENGTH; index++) {
    out = ALPHABET[Number(value & 31n)] + out
    value >>= 5n
  }
  return out
}

function encodeTime(time: number): string {
  let value = time
  let out = ''
  for (let index = 0; index < TIME_LENGTH; index++) {
    out = ALPHABET[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

/**
 * A ULID body: 26 Crockford characters, `Date`-time first.
 *
 * `previous` is the last id this generator produced. Passing it keeps the
 * output monotonic: inside the same millisecond the random part is incremented
 * instead of re-drawn. A caller that keeps no state still gets a valid,
 * sortable id, just without the intra-millisecond guarantee.
 */
export function ulid(now: number = Date.now(), randomBytes?: (n: number) => Uint8Array, previous?: string): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME) throw new Error('driveIdTimeInvalid')
  const draw = randomBytes ?? (n => globalThis.crypto.getRandomValues(new Uint8Array(n)))
  const time = encodeTime(now)
  // Same millisecond as the last id: step the previous random part by one.
  if (previous && previous.length === TIME_LENGTH + RANDOM_LENGTH && previous.slice(0, TIME_LENGTH) >= time) {
    const body = previous.slice(TIME_LENGTH)
    const incremented = incrementBase32(body)
    // All-ones overflowed: no room left in this millisecond, so move on instead
    // of repeating an id.
    if (incremented) return previous.slice(0, TIME_LENGTH) + incremented
    return ulid(now + 1, draw, undefined)
  }
  return time + encodeRandom(draw(RANDOM_LENGTH))
}

/** `body` plus one, or null when it would carry past 16 characters. */
function incrementBase32(body: string): string | null {
  let index = body.length - 1
  const characters = body.split('')
  while (index >= 0) {
    const position = ALPHABET.indexOf(characters[index]!)
    if (position < 0) return null
    if (position < 31) { characters[index] = ALPHABET[position + 1]!; return characters.join('') }
    characters[index] = ALPHABET[0]!
    index--
  }
  return null
}

/** A stateful generator: monotonic across calls, so ids sort in creation order. */
export function createUlidFactory(clock: () => number = Date.now, randomBytes?: (n: number) => Uint8Array) {
  let previous: string | undefined
  return () => {
    previous = ulid(clock(), randomBytes, previous)
    return previous
  }
}

/** The millisecond a ULID body was made at, for a `since`/`until` query. */
export function ulidTime(id: string): number | null {
  if (id.length !== TIME_LENGTH + RANDOM_LENGTH) return null
  let value = 0
  for (const character of id.slice(0, TIME_LENGTH)) {
    const position = ALPHABET.indexOf(character)
    if (position < 0) return null
    value = value * 32 + position
  }
  return value
}
