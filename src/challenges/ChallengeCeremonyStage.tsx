import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import type { ChallengePresentation } from "./useChallengePresentation";

export type ChallengeCeremonyStageProps = {
  presentation: ChallengePresentation;
  update: ChallengeUpdate;
  /** Rendert das Element in der linken oberen Ecke statt an der Kompositionsposition. */
  placementAtOrigin?: boolean;
};

// Zeremonie-Wrapper: identisches Markup für ChallengeSourceApp und
// CompositeApp. Die jeweiligen Aufrufer entscheiden, wann ein Update angezeigt
// wird; diese Komponente bleibt frei von Modulkopplungen.
export const ChallengeCeremonyStage = ({
  presentation,
  update,
  placementAtOrigin = false,
}: ChallengeCeremonyStageProps) => (
  <div
    className="challenge-source-ceremony"
    data-ceremony-event={presentation.activeCeremony?.eventType}
    data-ceremony-motion={presentation.activeCeremony === null ? undefined : presentation.reducedMotion ? "static" : "animated"}
    data-ceremony-type={presentation.activeCeremony?.visual}
    data-style={update.settings.styleId}
    data-surface-mode={update.settings.surfaceOpacity < 50 ? "bare" : "surface"}
    data-text-emphasis={update.settings.textEmphasis === "auto"
      ? update.settings.surfaceOpacity < 50 ? "strong" : "plain"
      : update.settings.textEmphasis}
    data-header-style={update.settings.headerStyle}
    data-font-family={update.settings.fontFamily}
  >
    <ChallengeLog
      ceremonySeq={presentation.activeCeremony?.eventSeq}
      {...presentation.activeCeremony === null
        ? {}
        : { ceremonyVisual: presentation.activeCeremony.visual }}
      {...placementAtOrigin
        ? { placement: { ...update.settings.placement, x: 0, y: 0 } }
        : {}}
      ceremonyTarget={presentation.ceremonyTarget}
      clockOffsetMs={presentation.clockOffsetMs}
      now={presentation.now}
      update={update}
    />
  </div>
);
