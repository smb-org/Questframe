import { describe, expect, it, vi } from "vitest";

import {
  calculateTimeSyncOffset,
  createTimeSyncClient,
} from "../../../src/shared/time-sync";

describe("Time-Sync", () => {
  it("berechnet den Offset anhand der Mitte der Umlaufzeit", () => {
    const sentAt = 1_700_000_000_000;
    const receivedAt = sentAt + 200;
    const serverTime = new Date(sentAt + 700).toISOString();

    expect(calculateTimeSyncOffset(sentAt, receivedAt, serverTime)).toBe(600);
  });

  it("übernimmt aus mehreren Proben die mit der kürzesten Umlaufzeit", () => {
    const send = vi.fn();
    const onOffset = vi.fn();
    const client = createTimeSyncClient({ send, onOffset, now: () => 1_700_000_000_000 });

    client.requestSamples();
    const requests = send.mock.calls.map(([value]) => JSON.parse(value as string) as { clientTimestamp: number });
    client.accept({
      type: "time_sync",
      clientTimestamp: requests[0]?.clientTimestamp ?? 0,
      serverTime: new Date(1_700_000_000_700).toISOString(),
    }, 1_700_000_000_400);
    client.accept({
      type: "time_sync",
      clientTimestamp: requests[1]?.clientTimestamp ?? 0,
      serverTime: new Date(1_700_000_001_500).toISOString(),
    }, 1_700_000_001_200);
    client.accept({
      type: "time_sync",
      clientTimestamp: requests[2]?.clientTimestamp ?? 0,
      serverTime: new Date(1_700_000_000_900).toISOString(),
    }, 1_700_000_000_100);

    expect(onOffset).toHaveBeenLastCalledWith(850);
  });
});
