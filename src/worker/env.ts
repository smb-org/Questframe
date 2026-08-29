import { parseKeyring } from "../channel/auth/crypto";

export type SecretKeyring = {
  active: { id: string; key: string };
  previous?: { id: string; key: string };
};

export type AppEnv = Env & {
  TWITCH_CLIENT_SECRET?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  SESSION_COOKIE_KEYS?: string;
  OVERLAY_TOKEN_PEPPER?: string;
};

export const REQUIRED_SECRET_NAMES = [
  "TWITCH_CLIENT_SECRET",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
] as const;

export const getMissingBindings = (env: AppEnv): string[] => {
  const missing: string[] = REQUIRED_SECRET_NAMES.filter((name) => {
    const value = env[name];
    return value === undefined || value.length === 0 || value.startsWith("replace-");
  });
  for (const name of ["SESSION_COOKIE_KEYS", "SESSION_ENCRYPTION_KEYS"] as const) {
    const value = env[name];
    if (value !== undefined && !missing.includes(name)) {
      try {
        parseKeyring(value);
      } catch {
        missing.push(name);
      }
    }
  }
  if (
    env.OVERLAY_TOKEN_PEPPER !== undefined &&
    !missing.includes("OVERLAY_TOKEN_PEPPER") &&
    !/^[A-Za-z0-9_-]{43}$/.test(env.OVERLAY_TOKEN_PEPPER)
  ) {
    missing.push("OVERLAY_TOKEN_PEPPER");
  }
  if (!/^\d+$/.test(env.BROADCASTER_ID)) missing.push("BROADCASTER_ID");
  if (!/^https:\/\//.test(env.PUBLIC_ORIGIN) && env.APP_ENV !== "local") {
    missing.push("PUBLIC_ORIGIN");
  }
  if (env.TWITCH_CLIENT_ID.startsWith("SET_")) missing.push("TWITCH_CLIENT_ID");
  return [...new Set(missing)];
};
