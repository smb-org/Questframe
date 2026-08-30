import { z } from "zod";

import { hmacHex, sha256Hex, timingSafeEqual } from "../crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64UrlToBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Ungültiges Base64url.");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${normalized}${"=".repeat((4 - (normalized.length % 4)) % 4)}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const keySchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/),
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const keyringSchema = z
  .strictObject({
    active: keySchema,
    previous: keySchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.previous?.id === value.active.id) {
      context.addIssue({
        code: "custom",
        path: ["previous", "id"],
        message: "Aktive und vorherige Key-ID müssen unterschiedlich sein.",
      });
    }
    for (const [name, entry] of [
      ["active", value.active],
      ["previous", value.previous],
    ] as const) {
      if (entry !== undefined && base64UrlToBytes(entry.key).byteLength !== 32) {
        context.addIssue({
          code: "custom",
          path: [name, "key"],
          message: "Schlüssel muss genau 32 Byte enthalten.",
        });
      }
    }
  });

export type SecretKeyring = z.infer<typeof keyringSchema>;

export const parseKeyring = (serialized: string): SecretKeyring => {
  let input: unknown;
  try {
    input = JSON.parse(serialized) as unknown;
  } catch {
    throw new Error("Keyring ist kein gültiges JSON.");
  }
  return keyringSchema.parse(input);
};

const getKey = (keyring: SecretKeyring, id: string): SecretKeyring["active"] | null => {
  if (keyring.active.id === id) return keyring.active;
  if (keyring.previous?.id === id) return keyring.previous;
  return null;
};

export const signValue = async (
  purpose: string,
  value: string,
  keyring: SecretKeyring,
): Promise<string> => {
  const encoded = bytesToBase64Url(encoder.encode(value));
  const payload = `v1.${keyring.active.id}.${encoded}`;
  const signature = await hmacHex(keyring.active.key, `${purpose}:${payload}`);
  return `${payload}.${signature}`;
};

export const verifySignedValue = async (
  purpose: string,
  signed: string,
  keyring: SecretKeyring,
): Promise<string | null> => {
  const parts = signed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const keyId = parts[1];
  const encoded = parts[2];
  const signature = parts[3];
  if (keyId === undefined || encoded === undefined || signature === undefined) return null;
  const key = getKey(keyring, keyId);
  if (key === null) return null;
  const expected = await hmacHex(key.key, `${purpose}:v1.${keyId}.${encoded}`);
  if (!timingSafeEqual(signature, expected)) return null;
  try {
    return decoder.decode(base64UrlToBytes(encoded));
  } catch {
    return null;
  }
};

export const signOpaqueCookie = (
  sessionId: string,
  keyring: SecretKeyring,
): Promise<string> => signValue("session-cookie", sessionId, keyring);

export const verifyOpaqueCookie = (
  cookie: string,
  keyring: SecretKeyring,
): Promise<string | null> => verifySignedValue("session-cookie", cookie, keyring);

export const tokenEnvelopeSchema = z.strictObject({
  version: z.literal(1),
  keyId: z.string().regex(/^[A-Za-z0-9_-]{1,24}$/),
  iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

export type TokenEnvelope = z.infer<typeof tokenEnvelopeSchema>;
export type TokenContext = {
  broadcasterId: string;
  sessionId: string;
  twitchUserId: string;
  tokenKind: "access" | "refresh";
};

const additionalData = (context: TokenContext): ArrayBuffer =>
  Uint8Array.from(
    encoder.encode(
      `irl-stream-hud-token:v1:${context.broadcasterId}:${context.sessionId}:${context.twitchUserId}:${context.tokenKind}`,
    ),
  ).buffer;

const importAesKey = async (
  key: SecretKeyring["active"],
  usages: KeyUsage[],
): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "raw",
    Uint8Array.from(base64UrlToBytes(key.key)).buffer,
    "AES-GCM",
    false,
    usages,
  );

const hexToBytes = (value: string): Uint8Array => {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Ungültiger SHA-256-Schlüssel.");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

// Derselbe Pepper dient als HMAC-Schluessel fuer token_hash. Der Praefix trennt
// die beiden Verwendungen, damit aus dem Verschluesselungsschluessel nichts ueber
// das HMAC-Schluesselmaterial folgt.
const OVERLAY_KEY_PURPOSE = "irl-stream-hud-overlay-token-key:v1:";

const importOverlayAesKey = async (
  pepper: string,
  usages: KeyUsage[],
): Promise<CryptoKey> => {
  const digest = await sha256Hex(`${OVERLAY_KEY_PURPOSE}${pepper}`);
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(hexToBytes(digest)).buffer,
    "AES-GCM",
    false,
    usages,
  );
};

const overlayAdditionalData = (capsuleId: string): ArrayBuffer =>
  Uint8Array.from(encoder.encode(`irl-stream-hud-overlay-token:v1:${capsuleId}`)).buffer;

export const encryptToken = async (
  token: string,
  keyring: SecretKeyring,
  context: TokenContext,
): Promise<TokenEnvelope> => {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importAesKey(keyring.active, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: Uint8Array.from(iv), additionalData: additionalData(context) },
    key,
    Uint8Array.from(encoder.encode(token)).buffer,
  );
  return tokenEnvelopeSchema.parse({
    version: 1,
    keyId: keyring.active.id,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
};

export const decryptToken = async (
  input: TokenEnvelope,
  keyring: SecretKeyring,
  context: TokenContext,
): Promise<string> => {
  const envelope = tokenEnvelopeSchema.parse(input);
  const entry = getKey(keyring, envelope.keyId);
  if (entry === null) throw new Error("Unbekannte Token-Key-ID.");
  const key = await importAesKey(entry, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(base64UrlToBytes(envelope.iv)),
      additionalData: additionalData(context),
    },
    key,
    Uint8Array.from(base64UrlToBytes(envelope.ciphertext)).buffer,
  );
  return decoder.decode(plaintext);
};

export const encryptOverlayToken = async (
  token: string,
  pepper: string,
  capsuleId: string,
): Promise<TokenEnvelope> => {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importOverlayAesKey(pepper, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: Uint8Array.from(iv), additionalData: overlayAdditionalData(capsuleId) },
    key,
    Uint8Array.from(encoder.encode(token)).buffer,
  );
  return tokenEnvelopeSchema.parse({
    version: 1,
    keyId: "pepper",
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
};

export const decryptOverlayToken = async (
  input: TokenEnvelope,
  pepper: string,
  capsuleId: string,
): Promise<string> => {
  const envelope = tokenEnvelopeSchema.parse(input);
  if (envelope.keyId !== "pepper") throw new Error("Unbekannte Overlay-Token-Key-ID.");
  const key = await importOverlayAesKey(pepper, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Uint8Array.from(base64UrlToBytes(envelope.iv)),
      additionalData: overlayAdditionalData(capsuleId),
    },
    key,
    Uint8Array.from(base64UrlToBytes(envelope.ciphertext)).buffer,
  );
  return decoder.decode(plaintext);
};
