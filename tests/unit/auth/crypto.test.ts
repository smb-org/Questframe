import { describe, expect, it } from "vitest";

import {
  decryptToken,
  encryptToken,
  parseKeyring,
  signOpaqueCookie,
  verifyOpaqueCookie,
  verifySignedValue,
  signValue,
} from "../../../src/channel/auth/crypto";

const keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const keyB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const activeOnly = JSON.stringify({ active: { id: "a", key: keyA } });
const rotated = JSON.stringify({
  active: { id: "b", key: keyB },
  previous: { id: "a", key: keyA },
});

describe("session cryptography", () => {
  it("parses exactly one active and at most one previous 32-byte key", () => {
    expect(parseKeyring(activeOnly).active.id).toBe("a");
    expect(() => parseKeyring('{"active":{"id":"a","key":"short"}}')).toThrow();
    expect(() =>
      parseKeyring(
        JSON.stringify({
          active: { id: "same", key: keyA },
          previous: { id: "same", key: keyB },
        }),
      ),
    ).toThrow(/unterschiedlich/);
  });

  it("signs cookies with the active key and verifies the retained previous key", async () => {
    const oldCookie = await signOpaqueCookie("opaque-session-id", parseKeyring(activeOnly));
    expect(await verifyOpaqueCookie(oldCookie, parseKeyring(rotated))).toBe("opaque-session-id");
    expect(await verifyOpaqueCookie(`${oldCookie}tampered`, parseKeyring(rotated))).toBeNull();
    expect(await verifyOpaqueCookie("bad", parseKeyring(rotated))).toBeNull();
  });

  it("signs OAuth state values without exposing key material", async () => {
    const signed = await signValue("oauth-state", "nonce", parseKeyring(activeOnly));
    expect(signed).not.toContain(keyA);
    expect(await verifySignedValue("oauth-state", signed, parseKeyring(rotated))).toBe("nonce");
    expect(await verifySignedValue("different", signed, parseKeyring(rotated))).toBeNull();
  });

  it("encrypts Twitch tokens with AES-GCM-bound context and detects tampering", async () => {
    const context = {
      broadcasterId: "12345678901234567890",
      sessionId: "session-1",
      twitchUserId: "99999999999999999999",
      tokenKind: "access" as const,
    };
    const envelope = await encryptToken("twitch-access-token", parseKeyring(activeOnly), context);
    expect(JSON.stringify(envelope)).not.toContain("twitch-access-token");
    expect(await decryptToken(envelope, parseKeyring(rotated), context)).toBe("twitch-access-token");
    await expect(
      decryptToken(envelope, parseKeyring(rotated), { ...context, sessionId: "copied-session" }),
    ).rejects.toThrow();
    await expect(
      decryptToken({ ...envelope, ciphertext: `${envelope.ciphertext}A` }, parseKeyring(rotated), context),
    ).rejects.toThrow();
  });
});
