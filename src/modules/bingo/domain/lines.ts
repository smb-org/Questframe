import type { BingoLine, BingoSize } from "../contracts/schemas";

export type NewlyCompletedResult = {
  lines: BingoLine[];
  fullCard: boolean;
};

type Marks = ReadonlySet<string> | readonly string[];

const asKnownMarks = (marks: Marks, cardIds: ReadonlySet<string>): Set<string> => {
  const result = new Set<string>();
  for (const id of marks) {
    if (cardIds.has(id)) result.add(id);
  }
  return result;
};

/**
 * Liefert nur Linien, die im neuen Stand vollständig sind und vorher fehlten.
 * Bei Vollkarte hat die Vollkarten-Zeremonie Vorrang; die Linien bleiben für
 * den Aufrufer trotzdem im Ergebnis.
 */
export const newlyCompleted = (
  before: Marks,
  after: Marks,
  cells: readonly string[],
  size: BingoSize,
): NewlyCompletedResult => {
  if (cells.length !== size * size || new Set(cells).size !== cells.length) {
    return { lines: [], fullCard: false };
  }

  const cardIds = new Set(cells);
  const beforeMarks = asKnownMarks(before, cardIds);
  const afterMarks = asKnownMarks(after, cardIds);
  const lines: BingoLine[] = [];

  const checkLine = (kind: BingoLine["kind"], index: number, positions: number[]): void => {
    if (positions.every((position) => {
      const id = cells[position];
      return id !== undefined && afterMarks.has(id);
    }) && !positions.every((position) => {
      const id = cells[position];
      return id !== undefined && beforeMarks.has(id);
    })) {
      lines.push({ kind, index });
    }
  };

  for (let row = 0; row < size; row += 1) {
    checkLine("row", row, Array.from({ length: size }, (_, column) => row * size + column));
  }
  for (let column = 0; column < size; column += 1) {
    checkLine("col", column, Array.from({ length: size }, (_, row) => row * size + column));
  }
  checkLine("diag", 0, Array.from({ length: size }, (_, index) => index * size + index));
  checkLine("diag", 1, Array.from({ length: size }, (_, index) => index * size + (size - index - 1)));

  const afterHasFullCard = cells.every((id) => afterMarks.has(id));
  const beforeHadFullCard = cells.every((id) => beforeMarks.has(id));

  return { lines, fullCard: afterHasFullCard && !beforeHadFullCard };
};

/** Leitet alle vollständigen Linien aus den aktuellen Kreuzen ab. */
export const completedLines = (
  marks: Marks,
  cells: readonly string[],
  size: BingoSize,
): BingoLine[] => newlyCompleted([], marks, cells, size).lines;

/** Liefert alle Zellen, die in der aktuellen Markierung zu einer fertigen Linie gehören. */
export const completedLineCellIds = (
  marks: Marks,
  cells: readonly string[],
  size: BingoSize,
): string[] => {
  const lines = completedLines(marks, cells, size);
  const result = new Set<string>();
  for (const line of lines) {
    for (let offset = 0; offset < size; offset += 1) {
      const position = line.kind === "row"
        ? line.index * size + offset
        : line.kind === "col"
          ? offset * size + line.index
          : line.index === 0
            ? offset * size + offset
            : offset * size + (size - offset - 1);
      const id = cells[position];
      if (id !== undefined) result.add(id);
    }
  }
  return [...result];
};
