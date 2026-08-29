import type { ChannelState } from "../shared/contracts/state";
import { parseOverlayState } from "./wire";

export const fingerprintOverlayToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(new TextEncoder().encode(token)).buffer,
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

export const cacheKeyFor = (capsuleId: string, fingerprint: string): string =>
  `hud:1:${capsuleId}:${fingerprint}`;

export const storeOverlaySnapshot = (
  capsuleId: string,
  fingerprint: string,
  state: ChannelState,
): void => {
  localStorage.setItem(cacheKeyFor(capsuleId, fingerprint), JSON.stringify(state));
};

export const loadOverlaySnapshot = (
  capsuleId: string,
  fingerprint: string,
): ChannelState | null => {
  const key = cacheKeyFor(capsuleId, fingerprint);
  const stored = localStorage.getItem(key);
  if (stored === null) return null;
  try {
    const parsed = parseOverlayState(JSON.parse(stored));
    if (parsed === null) throw new Error("Invalid cached state");
    return parsed;
  } catch {
    localStorage.removeItem(key);
    return null;
  }
};

export const removeOverlaySnapshot = (capsuleId: string, fingerprint: string): void => {
  localStorage.removeItem(cacheKeyFor(capsuleId, fingerprint));
};
