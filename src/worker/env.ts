import { parseKeyring } from "../channel/auth/crypto";

export type SecretKeyring = {
  active: { id: string; key: string };
  previous?: { id: string; key: string };
};

export const REQUIRED_SECRET_NAMES = [
  "TWITCH_CLIENT_SECRET",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
] as const;

type RequiredSecretName = (typeof REQUIRED_SECRET_NAMES)[number];

// Cloudflare's generated Env is the deploy-time contract. The optional edge here
// preserves runtime handling for an incompletely provisioned first deployment.
export type AppEnv = Omit<Env, RequiredSecretName | "APP_ENV"> & {
  APP_ENV: "local" | Env["APP_ENV"];
} & Partial<Pick<Env, RequiredSecretName>>;

const readStringBinding = (env: AppEnv, name: keyof AppEnv): string | undefined => {
  const value: unknown = Reflect.get(env, name);
  return typeof value === "string" ? value : undefined;
};

export const getMissingBindings = (env: AppEnv): string[] => {
  const missing: string[] = REQUIRED_SECRET_NAMES.filter((name) => {
    const value = readStringBinding(env, name);
    return value === undefined || value.length === 0 || value.startsWith("replace-");
  });
  for (const name of ["SESSION_COOKIE_KEYS", "SESSION_ENCRYPTION_KEYS"] as const) {
    const value = readStringBinding(env, name);
    if (value !== undefined && !missing.includes(name)) {
      try {
        const keyring = parseKeyring(value);
        if (keyring.active.key.startsWith("replace-")) missing.push(name);
      } catch {
        missing.push(name);
      }
    }
  }
  if (
    readStringBinding(env, "OVERLAY_TOKEN_PEPPER") !== undefined &&
    !missing.includes("OVERLAY_TOKEN_PEPPER") &&
    !/^[A-Za-z0-9_-]{43}$/.test(readStringBinding(env, "OVERLAY_TOKEN_PEPPER") ?? "")
  ) {
    missing.push("OVERLAY_TOKEN_PEPPER");
  }
  if (!/^\d+$/.test(readStringBinding(env, "BROADCASTER_ID") ?? "")) missing.push("BROADCASTER_ID");
  if (!/^https:\/\//.test(readStringBinding(env, "PUBLIC_ORIGIN") ?? "") && env.APP_ENV !== "local") {
    missing.push("PUBLIC_ORIGIN");
  }
  const twitchClientId = readStringBinding(env, "TWITCH_CLIENT_ID");
  if (twitchClientId === undefined || twitchClientId.startsWith("SET_")) {
    missing.push("TWITCH_CLIENT_ID");
  }
  return [...new Set(missing)];
};
