import { ZoomIn } from "lucide-react";
import { useEffect, useState, type ComponentProps, type ReactNode } from "react";

import type { ChannelState } from "../../shared/contracts/state";
import { HudRenderer } from "../../overlay/HudRenderer";

// Der Sekundentakt bleibt auf die Vorschau begrenzt, damit Eingaben im Rail
// nicht jede Sekunde die gesamte Admin-Konsole neu rendern.
export const TickingPreview = (props: Omit<ComponentProps<typeof HudRenderer>, "nowMilliseconds">) => {
  const [nowMilliseconds, setNowMilliseconds] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMilliseconds(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <HudRenderer {...props} nowMilliseconds={nowMilliseconds} />;
};

export const PreviewPanel = ({
  state,
  mediaUrls,
  previewOverlay,
  children,
  themeLabel,
  zoom,
  onZoomChange,
  hudInteraction,
  showHud = true,
}: {
  state: ChannelState;
  mediaUrls: ReadonlyMap<string, string>;
  previewOverlay?: ReactNode;
  children?: ReactNode;
  themeLabel?: string;
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  showHud?: boolean;
  hudInteraction?: Pick<ComponentProps<typeof HudRenderer>, "className" | "ariaLabel" | "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture" | "onKeyDown"> | undefined;
}) => {
  const [internalZoom, setInternalZoom] = useState(100);
  const previewZoom = zoom ?? internalZoom;
  const setPreviewZoom = onZoomChange ?? setInternalZoom;

  return (
    <section className="preview-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">OBS-Komposition</span><h1>Live-Vorschau</h1></div>
        <div className="preview-controls">
          <div className="preview-zoom">
            <ZoomIn aria-hidden="true" size={14} />
            <input
              aria-label="Vorschau-Zoom"
              max={200}
              min={60}
              onChange={(event) => setPreviewZoom(Number(event.target.value))}
              step={10}
              type="range"
              value={previewZoom}
            />
            <output>{previewZoom}%</output>
            <button
              aria-label="Vorschau-Zoom auf 100 % zurücksetzen"
              className="preview-reset"
              disabled={previewZoom === 100}
              onClick={() => setPreviewZoom(100)}
              type="button"
            >100%</button>
          </div>
          <span className="preview-scale">1920 × 1080 Referenz</span>
        </div>
      </div>
      <div className="preview-viewport">
        <div className="preview-stage" style={{ width: `${String(previewZoom)}%` }}>
          <div className="preview-canvas">
            <div className="preview-safe-area" />
            <div className="preview-hud-wrap">
              {showHud && <TickingPreview
                  forceVisible
                  mediaUrls={mediaUrls}
                  previewOverlay={previewOverlay}
                  state={state}
                  {...hudInteraction}
                />}
              {children}
            </div>
          </div>
        </div>
      </div>
      <div className="preview-foot">
        <span><i className="anchor-dot" />Oben links verankert</span>
        {themeLabel !== undefined && <span>{themeLabel}</span>}
      </div>
    </section>
  );
};
