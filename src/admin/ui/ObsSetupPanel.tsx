import {
  Check,
  Copy,
  Eye,
  EyeOff,
  RotateCw,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  applyDockTokenResponse,
  applyOverlayTokenResponse,
  copyObsUrl,
  maskTokenUrl,
  mutateObsToken,
  type DockTokenStatus,
  type ObsSetupApi,
  type ObsSetupSource,
  type OverlayTokenStatus,
} from "./obsSetup";

const SetupQrCode = ({ value, label }: { value: string; label: string }) => {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let disposed = false;
    void import("qrcode")
      .then(({ toDataURL }) => toDataURL(value, {
        errorCorrectionLevel: "M",
        margin: 2,
        width: 220,
      }))
      .then((nextSource) => {
        if (!disposed) setSource(nextSource);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
    };
  }, [value]);

  return (
    <div aria-label={label} className="challenge-setup__qr">
      {source !== null ? (
        <img alt={label} src={source} />
      ) : error ? (
        <p role="alert">QR-Code konnte nicht erzeugt werden.</p>
      ) : (
        <p>QR-Code wird vorbereitet …</p>
      )}
    </div>
  );
};

export const ObsSetupPanel = ({
  api,
  dockToken,
  online,
  onDockToken,
  onOverlayToken,
  overlayToken,
  sources,
}: {
  api: ObsSetupApi;
  dockToken: DockTokenStatus;
  online: boolean;
  onDockToken: (token: DockTokenStatus) => void;
  onOverlayToken: (token: OverlayTokenStatus) => void;
  overlayToken: OverlayTokenStatus;
  sources: ReadonlyArray<ObsSetupSource>;
}) => {
  const [secretsVisible, setSecretsVisible] = useState(false);
  const [copiedSource, setCopiedSource] = useState<string | null>(null);
  const [copyError, setCopyError] = useState("");
  const [tokenError, setTokenError] = useState("");
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const origin = window.location.origin;

  useEffect(() => () => {
    if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
  }, []);

  const copyUrl = async (source: ObsSetupSource) => {
    if (source.url === "") return;
    try {
      await copyObsUrl(source.url);
      setCopyError("");
      setCopiedSource(source.id);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        setCopiedSource(null);
        copiedTimer.current = null;
      }, 2_000);
    } catch {
      setCopyError("Link konnte nicht kopiert werden.");
    }
  };

  const mutateToken = async (source: ObsSetupSource) => {
    if (source.tokenKind === undefined || busyToken !== null || !online) return;
    const status = source.tokenKind === "overlay" ? overlayToken : dockToken;
    const rotate = status.exists;
    if (rotate && !window.confirm("Alte Token-URL sofort ungültig machen und neuen Token erzeugen?")) return;
    setBusyToken(source.id);
    setTokenError("");
    try {
      if (source.tokenKind === "overlay") {
        const result = await mutateObsToken({
          api,
          kind: "overlay",
          rotate,
          expectedGeneration: status.generation,
        });
        onOverlayToken(applyOverlayTokenResponse(overlayToken, result));
      } else {
        const result = await mutateObsToken({
          api,
          kind: "dock",
          rotate,
          expectedGeneration: status.generation,
        });
        onDockToken(applyDockTokenResponse(dockToken, result));
      }
    } catch (caught) {
      setTokenError(caught instanceof Error ? caught.message : "Token konnte nicht erzeugt werden.");
    } finally {
      setBusyToken(null);
    }
  };

  return (
    <section aria-labelledby="obs-setup-heading" className="challenge-setup-panel">
      <header className="challenge-setup-heading">
        <div>
          <span className="eyebrow">OBS-Einrichtung</span>
          <h2 id="obs-setup-heading">Alle Quellen auf einen Blick</h2>
          <p>Jede URL ist sofort kopierbar. Token bleiben standardmäßig verborgen und werden nur auf ausdrückliche Aktion angezeigt.</p>
        </div>
        <button
          aria-pressed={secretsVisible}
          className="button button--quiet challenge-setup__reveal"
          onClick={() => setSecretsVisible((current) => !current)}
          type="button"
        >
          {secretsVisible ? <EyeOff aria-hidden="true" size={16} /> : <Eye aria-hidden="true" size={16} />}
          {secretsVisible ? "URLs ausblenden" : "URLs anzeigen"}
        </button>
      </header>
      {copyError !== "" && <p className="challenge-board-error" role="alert">{copyError}</p>}
      {tokenError !== "" && <p className="challenge-board-error" role="alert">{tokenError}</p>}
      <div className="challenge-setup__sources">
        {sources.map((source) => {
          const canCopy = source.url !== "";
          const isCopied = copiedSource === source.id;
          const status = source.tokenKind === "dock" ? dockToken : overlayToken;
          const canManageToken = source.tokenKind !== undefined;
          const canMutate = source.tokenKind === "overlay"
            ? api.mutateOverlayToken !== undefined
            : source.tokenKind === "dock"
              ? api.mutateDockToken !== undefined
              : false;
          return (
            <article className={`challenge-setup__source challenge-setup__source--${source.id}`} key={source.id}>
              <div className="challenge-setup__source-heading">
                <div>
                  <h3>{source.name}</h3>
                  <p>{source.purpose}</p>
                </div>
                <span className="challenge-setup__size">
                  <strong>{source.size}</strong>
                  {source.stageNote !== undefined && <small>{source.stageNote}</small>}
                </span>
              </div>
              <div className="challenge-setup__url-line">
                <code aria-label={`${source.name} URL`}>{secretsVisible && canCopy ? source.url : maskTokenUrl(origin, source)}</code>
                <button
                  aria-label={`${source.name}-URL kopieren`}
                  className="button button--quiet challenge-setup__copy"
                  disabled={!canCopy}
                  onClick={() => void copyUrl(source)}
                  type="button"
                >
                  {isCopied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}
                  <span>{isCopied ? "Kopiert" : "Kopieren"}</span>
                </button>
              </div>
              {canManageToken && (
                <button
                  className="button button--primary challenge-setup__token-action"
                  disabled={busyToken !== null || !online || !canMutate}
                  onClick={() => void mutateToken(source)}
                  type="button"
                >
                  {busyToken === source.id && <RotateCw aria-hidden="true" className="spin" size={15} />}
                  {busyToken === source.id ? "Wird erzeugt …" : status.exists ? "Token ersetzen" : source.tokenKind === "overlay" ? "OBS-Link erzeugen" : "Dock-Link erzeugen"}
                </button>
              )}
              {source.instructions !== undefined && (
                <div className="challenge-setup__live-ways">
                  {source.instructions.map((instruction) => (
                    <div key={instruction.title}>
                      <strong>{instruction.title}</strong>
                      {(typeof instruction.body === "string" ? [instruction.body] : instruction.body).map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
                      {instruction.warning !== undefined && <p className="challenge-setup__warning">{instruction.warning}</p>}
                    </div>
                  ))}
                </div>
              )}
              {source.qrCode !== undefined && secretsVisible && source.url !== "" && (
                <>
                  <SetupQrCode key={source.url} label={source.qrCode.label} value={source.url} />
                  <p className="challenge-setup__qr-warning">{source.qrCode.warning}</p>
                </>
              )}
            </article>
          );
        })}
      </div>
      <p aria-live="polite" className="challenge-setup__privacy">Der Dock-Token darf Challenges verändern. Behandle URL und QR-Code wie ein Geheimnis.</p>
    </section>
  );
};
