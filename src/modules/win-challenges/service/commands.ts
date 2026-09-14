import type { ChallengeEvent, GlobalTimerEvent } from "../contracts/events";
import type { Command, Challenge } from "../contracts/schemas";
import type { ChallengeUpdate } from "../../../shared/contracts/win-challenges";
import {
  applyComplete,
  applyIncrement,
  applyPauseGlobal,
  applyReopen,
  applyResetTimer,
  applyResetGlobal,
  applyStartGlobal,
  applyStartTimer,
  applyStopTimer,
  DOMAIN_ERROR_MESSAGES,
  type DomainNow,
} from "../domain/timers";
import { isDeltaForKind, maxCountForKind, maxDeltaForKind } from "../contracts/predicates";
import { selectVisible } from "../domain/visibility";
import {
  NotFoundError,
  ValidationError,
  type BoardSaveResult,
  type ChallengeRepository,
  type ChallengeRepositorySettings,
  type ChallengeSnapshot,
  type ChallengeRuntime,
  type ChallengeRepositoryTransaction,
  type SettingsSaveResult,
} from "../repository/challenge-repository";

export type ChallengeUpdatePayload = Omit<ChallengeUpdate, "settings"> & {
  settings: Omit<ChallengeUpdate["settings"], "themeId">;
  event: ChallengeEvent | GlobalTimerEvent | null;
};

export type CommandResponse = {
  eventSeq: number;
  replayed: boolean;
  challenge?: Challenge;
  settings?: ChallengeRepositorySettings;
};

export type CommandExecutionResult = {
  response: CommandResponse;
  update: ChallengeUpdatePayload;
};

export type ChallengeClock = () => DomainNow;

export type WinChallengesOptions = {
  repository: ChallengeRepository;
  clock: ChallengeClock;
};

type CommandMutationValue = {
  challenge?: Challenge;
  settings?: ChallengeRepositorySettings;
  event: ChallengeEvent | GlobalTimerEvent | null;
  eventSeq?: number;
};

type CommandForType<Type extends Command["type"]> = Command & { type: Type };
type CanonicalCommandForType<Type extends Command["type"]> = Required<CommandForType<Type>>;

const toInstant = (now: DomainNow): string => {
  const milliseconds = typeof now === "number" ? now : Date.parse(now);
  if (!Number.isFinite(milliseconds)) throw new ValidationError("Ungültiger Zeitpunkt.");
  return new Date(milliseconds).toISOString();
};

const canonicalCommand = (command: Command): string => {
  switch (command.type) {
    case "increment": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
        challengeId: command.challengeId,
        delta: command.delta,
      } satisfies CanonicalCommandForType<"increment">;
      return JSON.stringify(canonical);
    }
    case "complete": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
        challengeId: command.challengeId,
      } satisfies CanonicalCommandForType<"complete">;
      return JSON.stringify(canonical);
    }
    case "reopen": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
        challengeId: command.challengeId,
      } satisfies CanonicalCommandForType<"reopen">;
      return JSON.stringify(canonical);
    }
    case "startTimer": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
        challengeId: command.challengeId,
      } satisfies CanonicalCommandForType<"startTimer">;
      return JSON.stringify(canonical);
    }
    case "stopTimer": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
        challengeId: command.challengeId,
      } satisfies CanonicalCommandForType<"stopTimer">;
      return JSON.stringify(canonical);
    }
    case "resetTimer": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
        challengeId: command.challengeId,
      } satisfies CanonicalCommandForType<"resetTimer">;
      return JSON.stringify(canonical);
    }
    case "startGlobalTimer": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
      } satisfies CanonicalCommandForType<"startGlobalTimer">;
      return JSON.stringify(canonical);
    }
    case "pauseGlobalTimer": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
      } satisfies CanonicalCommandForType<"pauseGlobalTimer">;
      return JSON.stringify(canonical);
    }
    case "resetGlobalTimer": {
      const canonical = {
        commandId: command.commandId,
        scope: command.scope,
        type: command.type,
      } satisfies CanonicalCommandForType<"resetGlobalTimer">;
      return JSON.stringify(canonical);
    }
    default: {
      const exhaustive: never = command;
      throw new Error(`Unbekannter Kommandotyp: ${String(exhaustive)}`);
    }
  }
};

export const hashChallengeCommand = async (command: Command): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalCommand(command)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const runtimeOf = (challenge: Challenge): ChallengeRuntime => ({
  currentCount: challenge.currentCount,
  state: challenge.state,
  timerEndsAt: challenge.timerEndsAt,
  timerRemainMs: challenge.timerRemainMs,
  completedAt: challenge.completedAt,
  hidden: challenge.hidden,
});

const challengeMutation = (
  transaction: ChallengeRepositoryTransaction,
  command: Extract<Command, { scope: "challenge" }>,
  now: DomainNow,
): CommandMutationValue => {
  const current = transaction.readChallenge(command.challengeId);
  if (current === null) throw new NotFoundError();

  if (command.type === "increment") {
    if (!isDeltaForKind(command.delta, current.kind)) {
      const maxDelta = maxDeltaForKind(current.kind);
      throw new ValidationError(`Delta muss zwischen -${String(maxDelta)} und ${String(maxDelta)} liegen.`);
    }
    const transition = applyIncrement(current, command.delta, now);
    if (transition.error !== undefined) {
      throw new ValidationError(DOMAIN_ERROR_MESSAGES[transition.error], transition.error);
    }
    if (transition.event === null) return { challenge: current, event: null };

    const challenge = transaction.incrementChallengeCount(
      command.challengeId,
      transition.challenge.currentCount - current.currentCount,
      current.kind === "measure"
        ? maxCountForKind(current.kind)
        : transition.challenge.targetCount ?? maxCountForKind(current.kind),
      transition.challenge.updatedAt,
      transition.event.type === "completed"
        ? {
            currentCount: transition.challenge.currentCount,
            state: transition.challenge.state,
            timerEndsAt: transition.challenge.timerEndsAt,
            timerRemainMs: transition.challenge.timerRemainMs,
            completedAt: transition.challenge.completedAt,
            hidden: transition.challenge.hidden,
          }
        : undefined,
    );
    if (challenge === null) throw new NotFoundError();
    return { challenge, event: transition.event };
  }

  const transition = command.type === "complete"
    ? applyComplete(current, now)
    : command.type === "reopen"
      ? applyReopen(current, now)
      : command.type === "startTimer"
        ? applyStartTimer(current, now)
        : command.type === "stopTimer"
          ? applyStopTimer(current, now)
          : applyResetTimer(current, now);
  if (transition.error !== undefined) {
    throw new ValidationError(DOMAIN_ERROR_MESSAGES[transition.error], transition.error);
  }
  if (transition.event === null) return { challenge: current, event: null };

  const challenge = transaction.updateChallengeRuntime(
    command.challengeId,
    runtimeOf(transition.challenge),
    transition.challenge.updatedAt,
  );
  if (challenge === null) throw new NotFoundError();
  return { challenge, event: transition.event };
};

const globalMutation = (
  transaction: ChallengeRepositoryTransaction,
  command: Extract<Command, { scope: "global" }>,
  now: DomainNow,
): CommandMutationValue => {
  const current = transaction.readSnapshot();
  const transition = command.type === "startGlobalTimer"
    ? applyStartGlobal(current.settings.globalTimer, now)
    : command.type === "pauseGlobalTimer"
      ? applyPauseGlobal(current.settings.globalTimer, now)
      : applyResetGlobal(current.settings.globalTimer, now);
  if (transition.error !== undefined) {
    throw new ValidationError(DOMAIN_ERROR_MESSAGES[transition.error], transition.error);
  }
  if (transition.event === null) {
    return { settings: { ...current.settings, globalTimer: transition.globalTimer }, event: null };
  }
  const eventSeq = transaction.updateGlobalTimer(transition.globalTimer);
  return {
    settings: { ...current.settings, globalTimer: transition.globalTimer },
    event: transition.event,
    eventSeq,
  };
};

export class WinChallengesService {
  private readonly repository: ChallengeRepository;
  private readonly clock: ChallengeClock;

  public constructor(options: WinChallengesOptions) {
    this.repository = options.repository;
    this.clock = options.clock;
  }

  public readSnapshot(): ChallengeSnapshot {
    return this.repository.readSnapshot();
  }

  public readChallengeUpdate(): ChallengeUpdatePayload {
    return { ...this.readSnapshot(), event: null };
  }

  public selectVisible(now: DomainNow = this.clock()): Challenge[] {
    const snapshot = this.repository.readSnapshot();
    return selectVisible(snapshot.challenges, now, { doneOrder: snapshot.settings.doneOrder });
  }

  public saveBoard(
    input: Omit<Parameters<ChallengeRepository["saveBoard"]>[0], "now">,
  ): BoardSaveResult {
    return this.repository.saveBoard({ ...input, now: this.clock() });
  }

  public saveSettings(
    input: Omit<Parameters<ChallengeRepository["saveSettings"]>[0], "now">,
  ): SettingsSaveResult {
    return this.repository.saveSettings({ ...input, now: this.clock() });
  }

  public async executeCommand(command: Command): Promise<CommandExecutionResult> {
    const now = this.clock();
    return this.executeCommandWithHash(command, await hashChallengeCommand(command), now);
  }

  public executeCommandWithHash(
    command: Command,
    requestHash: string,
    now: DomainNow = this.clock(),
  ): CommandExecutionResult {
    const commandResult = this.repository.runCommand<CommandMutationValue>(
      {
        commandId: command.commandId,
        requestHash,
        createdAt: toInstant(now),
      },
      (transaction) => {
        transaction.pruneCommands(now);
        const value = command.scope === "challenge"
          ? challengeMutation(transaction, command, now)
          : globalMutation(transaction, command, now);
        if (value.eventSeq === undefined) return { value, event: value.event };
        return { value, event: value.event, eventSeq: value.eventSeq };
      },
      (transaction) => {
        if (command.scope === "challenge") {
          const challenge = transaction.readChallenge(command.challengeId);
          if (challenge === null) throw new NotFoundError();
          return { challenge, event: null };
        }
        return {
          settings: transaction.readSnapshot().settings,
          event: null,
        };
      },
    );
    const snapshot = this.repository.readSnapshot();
    const update: ChallengeUpdatePayload = {
      ...snapshot,
      event: commandResult.replayed ? null : commandResult.value.event,
    };
    const response: CommandResponse = {
      eventSeq: commandResult.eventSeq,
      replayed: commandResult.replayed,
    };
    if (command.scope === "challenge") {
      if (commandResult.value.challenge === undefined) throw new Error("Challenge-Antwort fehlt.");
      response.challenge = commandResult.value.challenge;
    } else {
      if (commandResult.value.settings === undefined) throw new Error("Settings-Antwort fehlt.");
      response.settings = commandResult.value.settings;
    }
    return { response, update };
  }
}

export const createWinChallenges = (options: WinChallengesOptions): WinChallengesService =>
  new WinChallengesService(options);
