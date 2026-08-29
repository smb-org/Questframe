const encoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const randomToken = (length = 32): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
};

export const sha256Hex = async (value: string | Uint8Array): Promise<string> => {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const buffer = Uint8Array.from(bytes).buffer;
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
};

export const hmacHex = async (keyMaterial: string, value: string): Promise<string> => {
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64UrlToBytes(keyMaterial);
  } catch {
    keyBytes = encoder.encode(keyMaterial);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(keyBytes).buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    Uint8Array.from(encoder.encode(value)).buffer,
  );
  return bytesToHex(new Uint8Array(signature));
};

export const timingSafeEqual = (left: string, right: string): boolean => {
  const maximum = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < maximum; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
};
