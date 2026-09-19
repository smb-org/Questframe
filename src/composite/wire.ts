import { parseOverlayMessage } from "../overlay/wire";
import { isStateBearingMessage } from "../overlay/message-policy";
import { parseChallengeMessage } from "../challenges/wire";

type ParsedOverlayMessage = Extract<
  NonNullable<ReturnType<typeof parseOverlayMessage>>,
  { type: "snapshot" | "state_committed" }
>;
type ParsedChallengeMessage = NonNullable<ReturnType<typeof parseChallengeMessage>>;

export type CompositeDiscrimination =
  | { kind: "hud"; message: ParsedOverlayMessage | null }
  | { kind: "challenges"; message: ParsedChallengeMessage | null }
  | { kind: "token_revoked"; message: { type: "token_revoked" } | null }
  | { kind: "ignore" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseHudMessage = (input: unknown): ParsedOverlayMessage | null => {
  const parsed = parseOverlayMessage(input);
  return parsed !== null && (parsed.type === "snapshot" || parsed.type === "state_committed")
    ? parsed
    : null;
};

export const discriminateCompositeMessage = (input: unknown): CompositeDiscrimination => {
  // Die bestehende Policy ist die einzige Quelle dafür, welche Nachrichten den
  // HUD-Parser adressieren. Sie wird absichtlich nicht dupliziert.
  if (isStateBearingMessage(input)) {
    return { kind: "hud", message: parseHudMessage(input) };
  }
  if (isRecord(input) && input.type === "token_revoked") {
    const parsed = parseOverlayMessage(input);
    return {
      kind: "token_revoked",
      message: parsed?.type === "token_revoked" ? parsed : null,
    };
  }
  if (isRecord(input) && !Object.hasOwn(input, "type") && Object.hasOwn(input, "eventSeq")) {
    const parsed = parseChallengeMessage(input);
    return {
      kind: "challenges",
      message: parsed !== null && "eventSeq" in parsed ? parsed : null,
    };
  }
  return { kind: "ignore" };
};
