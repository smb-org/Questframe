import type { CSSProperties, HTMLAttributes } from "react";

import type { BingoBoardState } from "../modules/bingo/contracts/schemas";
import type { ChallengePlacement } from "../shared/contracts/win-challenges";
import type { BingoPresentation } from "./useBingoPresentation";
import { BingoBoard } from "./BingoBoard";

export const BingoCeremonyStage = ({
  board,
  presentation,
  placement,
  className,
  ariaLabel,
  rootProps,
  placementAtOrigin = false,
}: {
  board: BingoBoardState;
  presentation: Pick<BingoPresentation, "activeCeremony" | "reducedMotion">;
  placement?: ChallengePlacement;
  className?: string;
  ariaLabel?: string;
  rootProps?: Omit<HTMLAttributes<HTMLDivElement>, "children" | "className" | "style">;
  placementAtOrigin?: boolean;
}) => {
  const activePlacement = placement ?? board.placement;
  const style = {
    "--bingo-x": `${String(placementAtOrigin ? 0 : activePlacement.x * 5)}px`,
    "--bingo-y": `${String(placementAtOrigin ? 0 : activePlacement.y * 5)}px`,
    "--bingo-scale": activePlacement.scale,
  } as CSSProperties;

  return (
    <div
      {...rootProps}
      aria-label={ariaLabel}
      className={`bingo-source-ceremony ${className ?? ""}`.trim()}
      data-ceremony-motion={presentation.activeCeremony === null ? undefined : presentation.reducedMotion ? "static" : "animated"}
      data-style={board.style}
      data-ceremony-type={presentation.activeCeremony?.type}
      style={style}
    >
      <BingoBoard board={board} ceremonyLines={presentation.activeCeremony?.lines ?? []} />
      {presentation.activeCeremony !== null && (
        <div aria-live="polite" className="bingo-source__bingo-callout">BINGO!</div>
      )}
    </div>
  );
};
