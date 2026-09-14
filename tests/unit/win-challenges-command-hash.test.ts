import { describe, expect, it } from "vitest";

import type { Command } from "../../src/modules/win-challenges/contracts/schemas";
import { hashChallengeCommand } from "../../src/modules/win-challenges/service/commands";

const commandId = "11111111-1111-4111-8111-111111111111";
const challengeId = "challenge-1";

const commands = [
  { commandId, scope: "challenge", type: "increment", challengeId, delta: 1 },
  { commandId, scope: "challenge", type: "complete", challengeId },
  { commandId, scope: "challenge", type: "reopen", challengeId },
  { commandId, scope: "challenge", type: "startTimer", challengeId },
  { commandId, scope: "challenge", type: "stopTimer", challengeId },
  { commandId, scope: "challenge", type: "resetTimer", challengeId },
  { commandId, scope: "global", type: "startGlobalTimer" },
  { commandId, scope: "global", type: "pauseGlobalTimer" },
  { commandId, scope: "global", type: "resetGlobalTimer" },
] as const satisfies readonly Command[];

describe("Win-Challenges-Command-Hash", () => {
  it("erzeugt für jeden Kommandotyp eine stabile und eindeutige kanonische Form", async () => {
    const hashes = await Promise.all(commands.map(hashChallengeCommand));

    expect(hashes).toEqual([
      "05269ad7ef33ea422a2e7badf85fe5227eac6f9498057d166a90fc790da9d7f0",
      "e77657ea8c79cb474effe025b991e5b312c34d5a86915c4444179492fecddc32",
      "70db99db02d1c15bb3f2deade13408da9fc8172e34a5bfd7fa0037a04aeac8c5",
      "10317c9762e8ad481acc318004ac87d0b815d0d11d2d45859af2ca058d12e318",
      "48a2d907ec1cc5987dc3be6096f6a92476f283f639943a80788f6eba28ba16e2",
      "e35449db8baac1be0b83cc38da0e9a299ec34f48c86e69033f6f405cff31cf60",
      "79dcb833dc07e675a01b59a05d5b0c1c902599e1de19e0b068aae68e93fa3c30",
      "2a6917124b5299b66d3db7d11bac33d3f98be0a98583b6033d2027ae304bebaa",
      "b35adcc8a1ce544c53a83bba5d4ae8650b35413fdc129082c09422f5b752dc32",
    ]);
    expect(new Set(hashes).size).toBe(commands.length);
  });

  it("unterscheidet dieselbe commandId bei unterschiedlichem increment-Payload", async () => {
    const first = commands[0];
    const second = { ...first, delta: 2 };

    await expect(hashChallengeCommand(first)).resolves.toBe(
      "05269ad7ef33ea422a2e7badf85fe5227eac6f9498057d166a90fc790da9d7f0",
    );
    await expect(hashChallengeCommand(second)).resolves.toBe(
      "73acde2561453ca12d477035c84351de916fb9354832fb30a690767ac1269e2a",
    );
    await expect(hashChallengeCommand(first)).resolves.not.toBe(await hashChallengeCommand(second));
  });

  it("erzeugt für dasselbe Kommando bei Wiederholung denselben Hash", async () => {
    const command = commands[3];

    await expect(hashChallengeCommand(command)).resolves.toBe(await hashChallengeCommand(command));
  });

  it("normalisiert die Eingabefeldreihenfolge durch den kanonischen Aufbau", async () => {
    const command = commands[0];
    const reordered = {
      delta: command.delta,
      challengeId: command.challengeId,
      type: command.type,
      scope: command.scope,
      commandId: command.commandId,
    } as const satisfies Command;

    await expect(hashChallengeCommand(reordered)).resolves.toBe(await hashChallengeCommand(command));
  });
});
