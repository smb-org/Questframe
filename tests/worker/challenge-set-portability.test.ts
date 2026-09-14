import { env } from "cloudflare:workers";
import { runInDurableObject as runInTestDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { runMigrations } from "../../src/channel/migrations";
import { createSqlStorageChallengeRepository, type SqlStorageChallengeRepository } from "../../src/modules/win-challenges/adapters/sql-storage-challenge-repository";
import { challengeSetV1Schema, type Challenge, type ChallengeDefinition, type ChallengeSetV1, type Command } from "../../src/modules/win-challenges/contracts/schemas";
import { decodeChallengeSet, encodeChallengeSet } from "../../src/modules/win-challenges/domain/set-codec";
import { createWinChallenges, hashChallengeCommand, type CommandExecutionResult } from "../../src/modules/win-challenges/service/commands";

const sourceNow = "2026-09-14T12:00:00.000Z";
const recipientNow = "2026-09-14T13:00:00.000Z";
const sourceStub = env.CHANNEL.get(env.CHANNEL.idFromName(`challenge-set-source-${crypto.randomUUID()}`));
const recipientStub = env.CHANNEL.get(env.CHANNEL.idFromName(`challenge-set-recipient-${crypto.randomUUID()}`));

const inRepository = <T>(
  stub: DurableObjectStub,
  callback: (repository: SqlStorageChallengeRepository) => T,
): Promise<T> =>
  runInTestDurableObject(stub, (_instance, state) => {
    runMigrations(state.storage.sql, "challenge-set-portability-test");
    return callback(
      createSqlStorageChallengeRepository({
        sql: state.storage.sql,
        transactionSync: state.storage.transactionSync.bind(state.storage),
      }),
    );
  });

const requireChallenge = (challenges: readonly Challenge[], title: string): Challenge => {
  const challenge = challenges.find((candidate) => candidate.title === title);
  if (challenge === undefined) throw new Error(`Challenge fehlt: ${title}`);
  return challenge;
};

const requireChallengeByControlKey = (
  challenges: readonly Challenge[],
  controlKey: string,
): Challenge => {
  const challenge = challenges.find((candidate) => candidate.controlKey === controlKey);
  if (challenge === undefined) throw new Error(`Steuer-Key fehlt: ${controlKey}`);
  return challenge;
};

const definitionFields = (challenge: Challenge) => ({
  title: challenge.title,
  kind: challenge.kind,
  unit: challenge.unit,
  targetCount: challenge.targetCount,
  timerTotalMs: challenge.timerTotalMs,
  sortOrder: challenge.sortOrder,
  step: challenge.step,
  hidden: challenge.hidden,
});

const sortedDefinitions = (challenges: readonly Challenge[]) =>
  [...challenges].sort((left, right) => left.sortOrder - right.sortOrder).map(definitionFields);

const runCommand = async (
  stub: DurableObjectStub,
  command: Command,
  now: string,
): Promise<CommandExecutionResult> => {
  const requestHash = await hashChallengeCommand(command);
  return inRepository(stub, (repository) =>
    createWinChallenges({ repository, clock: () => now }).executeCommandWithHash(command, requestHash, now),
  );
};

const reserveControlKeys = async (keys: readonly string[]): Promise<void> => {
  await runInTestDurableObject(recipientStub, (_instance, state) => {
    for (const key of keys) {
      state.storage.sql.exec(
        "INSERT OR IGNORE INTO wc_retired_keys(control_key) VALUES (?)",
        key,
      );
    }
  });
};

const sourceDefinitions: readonly ChallengeDefinition[] = [
  {
    clientId: "source-measure",
    title: "Kilometer sammeln",
    kind: "measure",
    unit: "km",
    targetCount: 750,
    timerTotalMs: 90_000,
    sortOrder: 0,
    step: 25,
    hidden: true,
  },
  {
    clientId: "source-tick",
    title: "Ritual auslösen",
    kind: "tick",
    unit: null,
    targetCount: null,
    timerTotalMs: null,
    sortOrder: 1,
    step: 1,
    hidden: false,
  },
  {
    clientId: "source-counter",
    title: "Wasser zählen",
    kind: "counter",
    unit: null,
    targetCount: 12,
    timerTotalMs: 45_000,
    sortOrder: 2,
    step: 2,
    hidden: false,
  },
];

describe("Challenge-Set-Portabilität über zwei Durable Objects", () => {
  // gstack-shortcut(dec-ba649f26): Prüft die Datenseite, nicht die Benutzerstrecke.
  // Upgrade, sobald der Importdialog mehr kann als Datei wählen und bestätigen
  // oder ein Fehler auftritt, der nur in der UI-Kette sichtbar war.
  // Die zwei DOs umgehen die öffentliche HTTP-Schicht: getChannelStub bindet ein
  // Deployment über BROADCASTER_ID an genau einen Kanal. Dieser Test beweist
  // daher Codec- und Repository-Portabilität, nicht die echte Austauschstrecke.
  it("überträgt ein Board als Datei zwischen Kanälen und bedient es danach weiter", async () => {
    const sourceBoard = await inRepository(sourceStub, (repository) =>
      repository.saveBoard({ baseBoardRevision: 1, definitions: sourceDefinitions, now: sourceNow }),
    );

    const sourceCounter = requireChallenge(sourceBoard.snapshot.challenges, "Wasser zählen");
    const sourceMeasure = requireChallenge(sourceBoard.snapshot.challenges, "Kilometer sammeln");
    await runCommand(sourceStub, {
      commandId: crypto.randomUUID(),
      scope: "challenge",
      type: "increment",
      challengeId: sourceCounter.id,
      delta: sourceCounter.step,
    }, sourceNow);
    await runCommand(sourceStub, {
      commandId: crypto.randomUUID(),
      scope: "challenge",
      type: "increment",
      challengeId: sourceCounter.id,
      delta: sourceCounter.step,
    }, sourceNow);
    await runCommand(sourceStub, {
      commandId: crypto.randomUUID(),
      scope: "challenge",
      type: "startTimer",
      challengeId: sourceCounter.id,
    }, sourceNow);

    const sourceAfterCommands = await inRepository(sourceStub, (repository) => repository.readSnapshot());
    const sourceCounterAfterCommands = requireChallenge(sourceAfterCommands.challenges, sourceCounter.title);
    expect(sourceCounterAfterCommands).toMatchObject({
      currentCount: 4,
      bestCount: 4,
      state: "active",
      timerEndsAt: "2026-09-14T12:00:45.000Z",
      timerRemainMs: null,
    });

    const recipientBoard = await inRepository(recipientStub, (repository) =>
      repository.saveBoard({
        baseBoardRevision: 1,
        definitions: [{
          clientId: "recipient-old",
          title: "Alte Aufgabe",
          kind: "counter",
          unit: null,
          targetCount: 3,
          timerTotalMs: 10_000,
          sortOrder: 0,
          step: 1,
          hidden: false,
        }],
        now: recipientNow,
      }),
    );
    const { globalTimer, ...recipientSettings } = recipientBoard.snapshot.settings;
    void globalTimer;
    const recipientSettingsWithTimer = await inRepository(recipientStub, (repository) =>
      repository.saveSettings({
        ...recipientSettings,
        baseSettingsRevision: recipientBoard.snapshot.settingsRevision,
        globalTimerTotalMs: 120_000,
        now: recipientNow,
      }),
    );
    await runCommand(recipientStub, {
      commandId: crypto.randomUUID(),
      scope: "global",
      type: "startGlobalTimer",
    }, recipientNow);
    const recipientBeforeImport = await inRepository(recipientStub, (repository) => repository.readSnapshot());
    expect(recipientBeforeImport.settings.globalTimer).toEqual({
      totalMs: 120_000,
      endsAt: "2026-09-14T13:02:00.000Z",
      pausedRemainMs: null,
    });
    expect(recipientSettingsWithTimer.snapshot.settingsRevision).toBe(2);

    const exportedFile = encodeChallengeSet(sourceAfterCommands, {
      name: "Wasser und Wege",
      createdAt: sourceNow,
      now: sourceNow,
      includeProgress: true,
    });
    expect(exportedFile.challenges.find(({ title }) => title === sourceCounter.title)?.progress).toMatchObject({
      currentCount: 4,
      bestCount: 4,
      state: "pending",
      timerRemainMs: 45_000,
    });
    expect(exportedFile.challenges.find(({ title }) => title === sourceMeasure.title)).not.toHaveProperty("id");
    expect(exportedFile.challenges.find(({ title }) => title === sourceMeasure.title)).not.toHaveProperty("controlKey");

    // Das JSON-Roundtrip steht für die Datei-Grenze; der Import verwirft den
    // enthaltenen Fortschritt ausdrücklich über decodeChallengeSet(payload).
    const filePayload: ChallengeSetV1 = challengeSetV1Schema.parse(
      JSON.parse(JSON.stringify(exportedFile)) as unknown,
    );
    const imported = decodeChallengeSet(filePayload);

    // Die Quell-Keys werden im Ziel-Fixture reserviert, damit die Prüfung auf
    // neue Keys nicht von einer (unwahrscheinlichen) Zufallskollision abhängt.
    await reserveControlKeys(sourceAfterCommands.challenges.map(({ controlKey }) => controlKey));
    const importedBoard = await inRepository(recipientStub, (repository) =>
      repository.saveBoard({
        baseBoardRevision: recipientBeforeImport.boardRevision,
        definitions: imported.definitions,
        reason: "set-switch",
        now: recipientNow,
      }),
    );

    const sourceChallenges = sourceAfterCommands.challenges;
    const recipientChallenges = importedBoard.snapshot.challenges;
    expect(sortedDefinitions(recipientChallenges)).toEqual(sortedDefinitions(sourceChallenges));
    expect(recipientChallenges.map(({ id }) => id)).not.toEqual(sourceChallenges.map(({ id }) => id));
    expect(recipientChallenges.map(({ controlKey }) => controlKey)).not.toEqual(sourceChallenges.map(({ controlKey }) => controlKey));
    expect(recipientChallenges.every(({ id }) => !sourceChallenges.some((source) => source.id === id))).toBe(true);
    expect(recipientChallenges.every(({ controlKey }) => !sourceChallenges.some((source) => source.controlKey === controlKey))).toBe(true);
    expect(recipientChallenges.map(({ currentCount, bestCount, state, timerEndsAt, timerRemainMs, completedAt }) => ({
      currentCount,
      bestCount,
      state,
      timerEndsAt,
      timerRemainMs,
      completedAt,
    }))).toEqual(recipientChallenges.map(() => ({
      currentCount: 0,
      bestCount: 0,
      state: "pending",
      timerEndsAt: null,
      timerRemainMs: null,
      completedAt: null,
    })));
    expect(importedBoard.snapshot.settings.globalTimer).toEqual(recipientBeforeImport.settings.globalTimer);
    expect(importedBoard.snapshot.eventSeq).toBe(recipientBeforeImport.eventSeq + 1);

    const importedCounter = requireChallenge(recipientChallenges, sourceCounter.title);
    const addressedByControlKey = requireChallengeByControlKey(recipientChallenges, importedCounter.controlKey);
    expect(addressedByControlKey.id).toBe(importedCounter.id);

    await runCommand(recipientStub, {
      commandId: crypto.randomUUID(),
      scope: "challenge",
      type: "increment",
      challengeId: addressedByControlKey.id,
      delta: importedCounter.step,
    }, recipientNow);
    await runCommand(recipientStub, {
      commandId: crypto.randomUUID(),
      scope: "challenge",
      type: "startTimer",
      challengeId: addressedByControlKey.id,
    }, recipientNow);

    const recipientAfterCommands = await inRepository(recipientStub, (repository) => repository.readSnapshot());
    const recipientCounterAfterCommands = requireChallenge(recipientAfterCommands.challenges, importedCounter.title);
    expect(recipientCounterAfterCommands).toMatchObject({
      id: importedCounter.id,
      controlKey: importedCounter.controlKey,
      currentCount: importedCounter.step,
      state: "active",
      timerEndsAt: "2026-09-14T13:00:45.000Z",
      timerRemainMs: null,
    });
    expect(recipientAfterCommands.settings.globalTimer).toEqual(recipientBeforeImport.settings.globalTimer);
  });
});
