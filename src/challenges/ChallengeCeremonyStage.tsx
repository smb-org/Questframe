import type { ChallengeUpdate } from "../shared/contracts/win-challenges";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import type { ChallengePresentation } from "./useChallengePresentation";

export type ChallengeCeremonyStageProps = {
  presentation: ChallengePresentation;
  update: ChallengeUpdate;
};

// Zeremonie-Wrapper: identisches Markup für ChallengeSourceApp und
// CompositeApp. Was die beiden Flächen als `update` übergeben, unterscheidet
// sich (CompositeApp spiegelt z.B. die HUD-themeId hinein) — das bleibt
// bewusst Sache des jeweiligen Aufrufers, nicht dieser Komponente.
export const ChallengeCeremonyStage = ({ presentation, update }: ChallengeCeremonyStageProps) => (
  <div
    className="challenge-source-ceremony"
    data-ceremony-event={presentation.activeCeremony?.eventType}
    data-ceremony-motion={presentation.activeCeremony === null ? undefined : presentation.reducedMotion ? "static" : "animated"}
    data-ceremony-type={presentation.activeCeremony?.visual}
    data-style={update.settings.styleId}
  >
    <ChallengeLog
      ceremonySeq={presentation.activeCeremony?.eventSeq}
      ceremonyTarget={presentation.ceremonyTarget}
      now={presentation.now}
      update={update}
    />
  </div>
);
