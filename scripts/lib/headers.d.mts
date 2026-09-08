export type PublicOrigin = {
  /** Vollständiger Origin, z.B. "https://hud.example.invalid". */
  origin: string;
  /** Nur der Host, für die wss://-Quelle in connect-src. */
  host: string;
};

export declare const publicOriginFor: (
  environment: string | undefined,
  publicOrigin: string | undefined,
) => PublicOrigin;

export declare const renderHeaders: (source: string, origin: PublicOrigin) => string;
