export const CONTROL_KEY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export type ControlKeyRandomSource = (bytes: Uint8Array<ArrayBuffer>) => void;

export type ControlKeyAllocatorOptions = {
  randomValues?: ControlKeyRandomSource;
  maxAttempts?: number;
};

const CONTROL_KEY_LENGTH = 4;
const DEFAULT_MAX_ATTEMPTS = 128;
const MAX_RANDOM_DRAWS_PER_CANDIDATE = 256;
const RANDOM_BYTE_SPACE = 256;
const ACCEPTED_BYTE_LIMIT = Math.floor(RANDOM_BYTE_SPACE / CONTROL_KEY_ALPHABET.length)
  * CONTROL_KEY_ALPHABET.length;

const webCryptoRandomValues: ControlKeyRandomSource = (bytes) => {
  globalThis.crypto.getRandomValues(bytes);
};

const normalizeReservedKeys = (
  reservedKeySets: readonly Iterable<string>[],
): Set<string> => {
  const reservedKeys = new Set<string>();
  for (const keySet of reservedKeySets) {
    for (const key of keySet) reservedKeys.add(key.toUpperCase());
  }
  return reservedKeys;
};

const createCandidate = (randomValues: ControlKeyRandomSource): string | null => {
  const randomByte = new Uint8Array(1);
  let draws = 0;
  let candidate = "";

  while (candidate.length < CONTROL_KEY_LENGTH && draws < MAX_RANDOM_DRAWS_PER_CANDIDATE) {
    randomValues(randomByte);
    draws += 1;
    const value = randomByte[0];
    if (value === undefined || value >= ACCEPTED_BYTE_LIMIT) continue;
    const character = CONTROL_KEY_ALPHABET[value % CONTROL_KEY_ALPHABET.length];
    if (character === undefined) throw new Error("Das Steuer-Key-Alphabet ist ungültig.");
    candidate += character;
  }

  return candidate.length === CONTROL_KEY_LENGTH ? candidate : null;
};

export const allocateControlKey = (
  reservedKeySets: readonly Iterable<string>[],
  options: ControlKeyAllocatorOptions = {},
): string => {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts muss eine positive ganze Zahl sein.");
  }

  const randomValues = options.randomValues ?? webCryptoRandomValues;
  const reservedKeys = normalizeReservedKeys(reservedKeySets);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = createCandidate(randomValues);
    if (candidate !== null && !reservedKeys.has(candidate)) return candidate;
  }

  throw new Error(`Kein freier Steuer-Key nach ${String(maxAttempts)} Versuchen gefunden.`);
};
