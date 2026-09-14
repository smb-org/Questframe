import type {
  ChallengeEvent,
  ChallengeEventType,
  ChallengeStyleId,
  GlobalTimerEvent,
  GlobalTimerEventType,
} from "../shared/contracts/win-challenges";

export type CeremonySound = "tick" | "complete" | "quest-complete" | null;
export type CeremonyVisual = "progressed" | "completed" | "lost" | "quiet";
export type CeremonyTarget =
  | { kind: "challenge"; id: string }
  | { kind: "global" };

type CeremonyEvent = ChallengeEvent | GlobalTimerEvent;
type CeremonyEventType = ChallengeEventType | GlobalTimerEventType;
type CeremonyEntry = {
  visual: CeremonyVisual;
  sound: CeremonySound;
  durationMs: number;
  targetKind: "challenge" | "global";
};

const PLAIN_COMPLETED: CeremonyEntry = {
  visual: "completed",
  sound: "complete",
  durationMs: 520,
  targetKind: "challenge",
};

const PLAIN_CEREMONIES: Partial<Record<CeremonyEventType, CeremonyEntry>> = {
  progressed: { visual: "progressed", sound: "tick", durationMs: 360, targetKind: "challenge" },
  completed: PLAIN_COMPLETED,
  // Der Fall bekommt den vorhandenen neutralen Einzelton, keinen Abschlussklang.
  "streak-reset": { visual: "lost", sound: "tick", durationMs: 520, targetKind: "challenge" },
  reopened: { visual: "quiet", sound: null, durationMs: 260, targetKind: "challenge" },
  timer_started: { visual: "quiet", sound: null, durationMs: 260, targetKind: "challenge" },
  timer_stopped: { visual: "quiet", sound: null, durationMs: 260, targetKind: "challenge" },
  global_started: { visual: "quiet", sound: null, durationMs: 260, targetKind: "global" },
  global_paused: { visual: "quiet", sound: null, durationMs: 260, targetKind: "global" },
  global_reset: { visual: "quiet", sound: null, durationMs: 260, targetKind: "global" },
};

const QUEST_LOG_CEREMONIES: Partial<Record<CeremonyEventType, CeremonyEntry>> = {
  ...PLAIN_CEREMONIES,
  completed: { ...PLAIN_COMPLETED, sound: "quest-complete" },
};

// Die Registry bleibt beim Host: Ein späterer Style kann hier ergänzt werden,
// ohne das herauslösbare Win-Challenges-Modul mit Zeremonien zu belasten.
const CEREMONY_REGISTRY: Partial<Record<ChallengeStyleId, Partial<Record<CeremonyEventType, CeremonyEntry>>>> = {
  "plain-list": PLAIN_CEREMONIES,
  "plain-bullets": PLAIN_CEREMONIES,
  "quest-log": QUEST_LOG_CEREMONIES,
};

export type ChallengeCeremony = Omit<CeremonyEntry, "targetKind"> & {
  eventType: CeremonyEventType;
  target: CeremonyTarget;
};

export const ceremonyFor = (
  styleId: ChallengeStyleId,
  event: CeremonyEvent,
): ChallengeCeremony | null => {
  const entry = CEREMONY_REGISTRY[styleId]?.[event.type];
  if (entry === undefined) return null;
  return {
    visual: entry.visual,
    sound: entry.sound,
    durationMs: entry.durationMs,
    eventType: event.type,
    target: entry.targetKind === "global"
      ? { kind: "global" }
      : event.scope === "challenge"
        ? { kind: "challenge", id: event.challengeId }
        : { kind: "global" },
  };
};
