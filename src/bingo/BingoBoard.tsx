import type { CSSProperties } from "react";

import { completedLineCellIds, completedLines } from "../modules/bingo/domain/lines";
import type { BingoBoardState, BingoLine, BingoStyleId } from "../modules/bingo/contracts/schemas";

const segmenter = new Intl.Segmenter("de", { granularity: "grapheme" });

const cellFontSize = (text: string, size: BingoBoardState["card"]["size"], width: number): string => {
  const graphemes = [...segmenter.segment(text)].length;
  const cellExtent = width / size;
  const innerExtent = cellExtent * 0.86;
  for (let fontSize = 28; fontSize >= 8; fontSize -= 1) {
    const graphemesPerLine = Math.max(1, Math.floor(innerExtent / fontSize));
    const lineCount = Math.ceil(graphemes / graphemesPerLine);
    if (lineCount * fontSize * 1.08 <= innerExtent) return `${String(fontSize)}px`;
  }
  return "8px";
};

const outlinePath = (line: BingoLine, size: number): string => {
  if (line.kind === "row") {
    const y = ((line.index + 0.5) / size) * 100;
    const radius = 43 / size;
    return `M 2 ${String(y)} C 8 ${String(y - radius)} 17 ${String(y - radius * 1.12)} 28 ${String(y - radius * 0.84)} S 48 ${String(y - radius * 1.08)} 58 ${String(y - radius * 0.9)} S 82 ${String(y - radius * 1.1)} 98 ${String(y - radius * 0.16)} C 101 ${String(y + radius * 0.55)} 88 ${String(y + radius)} 72 ${String(y + radius * 0.82)} S 48 ${String(y + radius * 1.13)} 34 ${String(y + radius * 0.9)} S 11 ${String(y + radius * 1.12)} 2 ${String(y)}`;
  }
  if (line.kind === "col") {
    const x = ((line.index + 0.5) / size) * 100;
    const radius = 43 / size;
    return `M ${String(x)} 2 C ${String(x - radius)} 8 ${String(x - radius * 1.12)} 18 ${String(x - radius * 0.84)} 30 S ${String(x - radius * 1.08)} 49 ${String(x - radius * 0.9)} 60 S ${String(x - radius * 1.1)} 84 ${String(x - radius * 0.16)} 98 C ${String(x + radius * 0.55)} 101 ${String(x + radius)} 89 ${String(x + radius * 0.82)} 73 S ${String(x + radius * 1.13)} 48 ${String(x + radius * 0.9)} 34 S ${String(x + radius * 1.12)} 11 ${String(x)} 2`;
  }
  const reverse = line.index === 1;
  return reverse
    ? "M 97 4 C 76 26 70 30 52 50 S 24 81 3 96"
    : "M 3 4 C 22 23 29 31 50 50 S 76 81 97 96";
};

export const BingoBoard = ({
  board,
  styleId = board.style,
  width = 520,
  onToggleCell,
  ceremonyLines = [],
}: {
  board: BingoBoardState;
  styleId?: BingoStyleId;
  width?: number;
  onToggleCell?: (cellId: string, marked: boolean) => void;
  ceremonyLines?: readonly BingoLine[];
}) => {
  const marked = new Set(board.marks);
  const completedCells = new Set(completedLineCellIds(board.marks, board.card.cells.map(({ id }) => id), board.card.size));
  const lines = completedLines(board.marks, board.card.cells.map(({ id }) => id), board.card.size);
  const ceremonyLineKeys = new Set(ceremonyLines.map(({ kind, index }) => `${kind}-${String(index)}`));
  const full = board.marks.length === board.card.cells.length;
  const markedCount = board.marks.length;
  const totalCount = board.card.cells.length;
  const badgeLine = lines[0];
  const badgeX = badgeLine?.kind === "col" ? ((badgeLine.index + 0.5) / board.card.size) * 100 : 50;
  const style = {
    "--bingo-size": String(board.card.size),
    "--bingo-board-width": `${String(width)}px`,
    "--bingo-cell-extent": `${String(width / board.card.size)}px`,
    "--bingo-progress": `${String(totalCount === 0 ? 0 : (markedCount / totalCount) * 100)}%`,
    "--bingo-badge-x": `${String(badgeX)}%`,
  } as CSSProperties;

  return (
    <section
      aria-label={board.card.title}
      className="bingo-source"
      data-style={styleId}
      data-full={full ? "true" : undefined}
      style={style}
    >
      <header className="bingo-source__header">
        <h2 className="bingo-source__title">{board.card.title}</h2>
        <span className="bingo-source__counter">{String(markedCount)}/{String(totalCount)}</span>
        <div
          aria-label="Bingo-Fortschritt"
          aria-valuemax={totalCount}
          aria-valuemin={0}
          aria-valuenow={markedCount}
          className="bingo-source__progress"
          role="progressbar"
        ><span className="bingo-source__progress-fill" /></div>
      </header>
      {lines.length > 0 && <span aria-hidden="true" className="bingo-source__bingo-badge">BINGO</span>}
      <div aria-label={board.card.title} className="bingo-source__grid" role="grid">
        {board.card.cells.map((cell, index) => {
          const isMarked = marked.has(cell.id);
          const lineComplete = completedCells.has(cell.id);
          const cellStyle = { "--bingo-cell-font-size": cellFontSize(cell.text, board.card.size, width) } as CSSProperties;
          return (
            <button
              aria-label={`${cell.text}${isMarked ? ", angekreuzt" : ""}`}
              aria-pressed={isMarked}
              className="bingo-source__cell"
              data-cell-id={cell.id}
              data-index={index}
              data-line-complete={lineComplete ? "true" : "false"}
              data-marked={isMarked ? "true" : "false"}
              disabled={onToggleCell === undefined}
              key={cell.id}
              onClick={() => onToggleCell?.(cell.id, !isMarked)}
              role="gridcell"
              style={cellStyle}
              type="button"
            >
              <span className="bingo-source__text">{cell.text}</span>
              {isMarked && (
                <svg aria-hidden="true" className="bingo-source__mark" viewBox="0 0 100 100">
                  <path d="M 9 13 C 29 33 68 69 91 90" />
                  <path d="M 90 10 C 69 34 32 69 10 91" />
                </svg>
              )}
            </button>
          );
        })}
        <svg aria-hidden="true" className="bingo-source__line-art" viewBox="0 0 100 100" preserveAspectRatio="none">
          {lines.map((line) => {
            const key = `${line.kind}-${String(line.index)}`;
            return <path className="bingo-source__line-outline" d={outlinePath(line, board.card.size)} data-ceremony-line={ceremonyLineKeys.has(key) ? "true" : "false"} key={key} />;
          })}
        </svg>
      </div>
    </section>
  );
};
