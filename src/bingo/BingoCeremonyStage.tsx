import type { CSSProperties, HTMLAttributes } from "react";
import { MoveDiagonal2 } from "lucide-react";

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
  resizeHandleProps,
}: {
  board: BingoBoardState;
  presentation: Pick<BingoPresentation, "activeCeremony" | "reducedMotion">;
  placement?: ChallengePlacement;
  className?: string;
  ariaLabel?: string;
  rootProps?: Omit<HTMLAttributes<HTMLDivElement>, "children" | "className" | "style">;
  placementAtOrigin?: boolean;
  resizeHandleProps?: Pick<HTMLAttributes<HTMLButtonElement>, "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture">;
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
      data-ceremony-motion={presentation.activeCeremony === null ? undefined : presentation.reducedMotion ? "static" : board.settings.ceremonyMode === "subtle" ? "subtle" : "animated"}
      data-style={board.style}
      data-ceremony-type={presentation.activeCeremony?.type}
      style={style}
    >
      <BingoBoard board={board} ceremonyLines={presentation.activeCeremony?.lines ?? []} />
      {presentation.activeCeremony !== null && board.settings.showBingo && (
        <div aria-live="polite" className="bingo-source__bingo-callout">BINGO!</div>
      )}
      {resizeHandleProps !== undefined && (
        <button
          aria-label="Bingo-Karte skalieren"
          className="bingo-preview-resize-handle"
          type="button"
          {...resizeHandleProps}
        ><MoveDiagonal2 aria-hidden="true" size={16} /></button>
      )}
    </div>
  );
};
