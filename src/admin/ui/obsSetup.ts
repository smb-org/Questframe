import type {
  BootstrapResponse,
  DockTokenResponse,
  OverlayTokenResponse,
} from "../../shared/contracts/api";

export type OverlayTokenStatus = BootstrapResponse["capsule"]["overlayToken"];
export type DockTokenStatus = NonNullable<BootstrapResponse["capsule"]["dockToken"]>;
export type ObsTokenKind = "overlay" | "dock";

export type ObsSetupApi = {
  mutateOverlayToken?: ((
    rotate: boolean,
    request: { requestId: string; expectedGeneration: number },
  ) => Promise<OverlayTokenResponse>) | undefined;
  mutateDockToken?: ((
    rotate: boolean,
    request: { requestId: string; expectedGeneration: number },
  ) => Promise<DockTokenResponse>) | undefined;
};

export type ObsSetupSource = {
  id: string;
  name: string;
  path: string;
  url: string;
  size: string;
  purpose: string;
  tokenKind?: ObsTokenKind;
  stageNote?: string;
  instructions?: ReadonlyArray<{
    title: string;
    body: string | ReadonlyArray<string>;
    warning?: string;
  }>;
  qrCode?: {
    label: string;
    warning: string;
  };
};

export const buildTokenUrl = (origin: string, path: string, token: string | null): string =>
  token === null ? "" : `${origin}${path}#token=${token}`;

export const maskTokenUrl = (origin: string, source: Pick<ObsSetupSource, "path" | "url">): string =>
  source.url === ""
    ? `${origin}${source.path} · Token noch nicht erzeugt`
    : `${origin}${source.path}#token=••••••`;

export const copyObsUrl = async (url: string): Promise<void> => {
  if (url === "") return;
  await navigator.clipboard.writeText(url);
};

export function mutateObsToken(input: {
  api: ObsSetupApi;
  kind: "overlay";
  rotate: boolean;
  expectedGeneration: number;
}): Promise<OverlayTokenResponse>;
export function mutateObsToken(input: {
  api: ObsSetupApi;
  kind: "dock";
  rotate: boolean;
  expectedGeneration: number;
}): Promise<DockTokenResponse>;
export async function mutateObsToken({
  api,
  kind,
  rotate,
  expectedGeneration,
}: {
  api: ObsSetupApi;
  kind: ObsTokenKind;
  rotate: boolean;
  expectedGeneration: number;
}): Promise<OverlayTokenResponse | DockTokenResponse> {
  const mutate = kind === "overlay"
    ? api.mutateOverlayToken?.bind(api)
    : api.mutateDockToken?.bind(api);
  if (mutate === undefined) {
    throw new Error(kind === "overlay" ? "OBS-Link kann nicht erzeugt werden." : "Dock-Link kann nicht erzeugt werden.");
  }
  return mutate(rotate, {
    requestId: crypto.randomUUID(),
    expectedGeneration,
  });
}

export const applyOverlayTokenResponse = (
  current: OverlayTokenStatus,
  response: OverlayTokenResponse,
): OverlayTokenStatus => ({
  ...current,
  exists: true,
  generation: response.generation,
  createdAt: response.createdAt,
  lastUsedAt: null,
  connectedSockets: 0,
  token: response.token,
});

export const applyDockTokenResponse = (
  current: DockTokenStatus,
  response: DockTokenResponse,
): DockTokenStatus => ({
  ...current,
  exists: true,
  generation: response.generation,
  fingerprint: response.fingerprint,
  createdAt: response.createdAt,
  lastUsedAt: null,
  connectedSockets: 0,
  token: response.token,
});

export const createChallengeObsSources = (
  origin: string,
  overlayToken: OverlayTokenStatus,
  dockToken: DockTokenStatus,
): ObsSetupSource[] => [
  {
    id: "hud",
    name: "HUD-Overlay",
    path: "/overlay",
    url: buildTokenUrl(origin, "/overlay", overlayToken.token),
    size: "1920 × 1080 px",
    purpose: "Zeigt das veröffentlichte HUD in der OBS-Ausgabe.",
    tokenKind: "overlay",
    stageNote: "Stage 630 × 259 px innerhalb der OBS-Fläche",
  },
  {
    id: "log",
    name: "Challenge-Log",
    path: "/overlay/challenges",
    url: buildTokenUrl(origin, "/overlay/challenges", overlayToken.token),
    size: "1920 × 1080 px",
    purpose: "Wird vollflächig in OBS eingebunden; die Position und Skalierung des Challenge-Logs stellst du im Admin ein.",
  },
  {
    id: "live",
    name: "Live-Bedienseite",
    path: "/live/challenges",
    url: buildTokenUrl(origin, "/live/challenges", dockToken.token),
    size: "mindestens 280 px breit; Höhe nach Inhalt",
    purpose: "Steuert Challenges und Timer live, ohne in der Stream-Ausgabe zu erscheinen.",
    tokenKind: "dock",
    instructions: [
      {
        title: "Handy-Weg",
        body: "QR-Code scannen und die Live-Seite neben der Tastatur öffnen.",
      },
      {
        title: "OBS-Weg",
        body: [
          "In OBS: View → Docks → Custom Browser Docks.",
          "Der eingebettete Browser hat ein eigenes Cookie-Profil. Diese Seite authentifiziert per Token-URL, nicht per Login.",
        ],
        warning: "Browser-Docks stehen unter Wayland nicht zur Verfügung.",
      },
    ],
    qrCode: {
      label: "QR-Code für die Live-Bedienseite",
      warning: "QR-Code nicht im Stream zeigen – er enthält Schreibzugriff auf deine Challenges.",
    },
  },
];
