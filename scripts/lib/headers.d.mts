export type PublicOrigin = {
  /** Vollständiger Origin, z.B. "https://hud.example.invalid". */
  origin: string;
  /** Nur der Host, für die wss://-Quelle in connect-src. */
  host: string;
};

export type WranglerConfig = {
  env?: Record<string, { routes?: Array<{ pattern?: string }> } | undefined>;
};

export declare const publicOriginFor: (
  config: WranglerConfig,
  environment: string | undefined,
) => PublicOrigin;

export declare const renderHeaders: (source: string, origin: PublicOrigin) => string;
