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
// CompositeApp. Was die beiden Flächen als `update` übergeben, unterscheidet
// sich (CompositeApp spiegelt z.B. die HUD-themeId hinein) — das bleibt
// bewusst Sache des jeweiligen Aufrufers, nicht dieser Komponente.
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
    data-header-style={update.settings.headerStyle}
  >
    <ChallengeLog
      ceremonySeq={presentation.activeCeremony?.eventSeq}
      {...placementAtOrigin
        ? { placement: { ...update.settings.placement, x: 0, y: 0 } }
        : {}}
      ceremonyTarget={presentation.ceremonyTarget}
      now={presentation.now}
      update={update}
    />
  </div>
);
