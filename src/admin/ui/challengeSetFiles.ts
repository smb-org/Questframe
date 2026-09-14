import {
  challengeSetV1Schema,
  type ChallengeSetV1,
} from "../../modules/win-challenges/contracts/schemas";
import { MAX_CHALLENGES } from "../../modules/win-challenges/contracts/predicates";

export const MAX_CHALLENGE_SET_FILE_BYTES = 64 * 1024;

export type ChallengeSetFileErrorCode = "too-large" | "invalid-json" | "invalid-schema";

export class ChallengeSetFileError extends Error {
  constructor(
    readonly code: ChallengeSetFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChallengeSetFileError";
  }
}

type ReadableChallengeSetFile = Pick<File, "name" | "size" | "text">;

const fieldName = (path: readonly PropertyKey[]): string =>
  path.length === 0 ? "Datei" : path.map((part) => String(part)).join(".");

const setFileError = (code: ChallengeSetFileErrorCode, message: string): ChallengeSetFileError =>
  new ChallengeSetFileError(code, message);

export const readChallengeSetFile = async (
  file: ReadableChallengeSetFile,
): Promise<{ payload: ChallengeSetV1; fileName: string }> => {
  if (file.size > MAX_CHALLENGE_SET_FILE_BYTES) {
    throw setFileError("too-large", `Set-Datei: ${file.name} ist zu groß (maximal 64 KiB).`);
  }

  let value: unknown;
  try {
    value = JSON.parse(await file.text()) as unknown;
  } catch {
    throw setFileError("invalid-json", "Set-Datei: JSON ist ungültig.");
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as { schemaVersion?: unknown; challenges?: unknown };
    if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== 1) {
      const version = typeof candidate.schemaVersion === "string" || typeof candidate.schemaVersion === "number" || typeof candidate.schemaVersion === "boolean"
        ? String(candidate.schemaVersion)
        : "unbekannt";
      throw setFileError(
        "invalid-schema",
        `Set-Datei schemaVersion: Version ${version} wird nicht unterstützt; erwartet wird Version 1.`,
      );
    }
    if (Array.isArray(candidate.challenges) && candidate.challenges.length > MAX_CHALLENGES) {
      throw setFileError(
        "invalid-schema",
        `Set-Datei challenges: ${String(candidate.challenges.length)} Aufgaben erkannt; maximal ${String(MAX_CHALLENGES)} sind erlaubt.`,
      );
    }
  }

  const parsed = challengeSetV1Schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw setFileError(
      "invalid-schema",
      `Set-Datei ${fieldName(issue?.path ?? [])}: ${issue?.message ?? "Datei entspricht nicht dem Set-Format."}`,
    );
  }
  return { payload: parsed.data, fileName: file.name };
};

const fileStem = (name: string): string => {
  const sanitized = name
    .trim()
    .split("")
    .map((character) => /[<>:"/\\|?*]/u.test(character) || character.charCodeAt(0) < 32 ? "-" : character)
    .join("")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return sanitized === "" ? "Challenge-Board" : sanitized;
};

const localDatePart = (date: Date): string => [
  date.getFullYear(),
  date.getMonth() + 1,
  date.getDate(),
].map((part) => String(part).padStart(2, "0")).join("-");

export const downloadChallengeSet = (payload: ChallengeSetV1, date: Date): void => {
  const datePart = localDatePart(date);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `${fileStem(payload.name)}-${datePart}.json`;
  anchor.rel = "noopener";
  anchor.click();
  URL.revokeObjectURL(objectUrl);
};
