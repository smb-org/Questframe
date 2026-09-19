export type TimeSyncMessage = {
  type: "time_sync";
  clientTimestamp: number;
  serverTime: string;
};

export const TIME_SYNC_SAMPLE_COUNT = 3;
export const TIME_SYNC_INTERVAL_MS = 5 * 60 * 1_000;

export const calculateTimeSyncOffset = (
  sentAtMs: number,
  receivedAtMs: number,
  serverTime: string,
): number | null => {
  if (
    !Number.isFinite(sentAtMs) ||
    !Number.isFinite(receivedAtMs) ||
    receivedAtMs < sentAtMs
  ) return null;
  const serverTimeMs = Date.parse(serverTime);
  if (!Number.isFinite(serverTimeMs)) return null;
  const midpointMs = sentAtMs + (receivedAtMs - sentAtMs) / 2;
  return serverTimeMs - midpointMs;
};

type PendingSample = {
  clientTimestamp: number;
  sentAtMs: number;
};

export type TimeSyncClient = {
  requestSamples: () => void;
  accept: (message: TimeSyncMessage, receivedAtMs: number) => void;
  reset: () => void;
};

export const createTimeSyncClient = ({
  send,
  onOffset,
  now = Date.now,
}: {
  send: (message: string) => void;
  onOffset: (offsetMs: number) => void;
  now?: () => number;
}): TimeSyncClient => {
  const pending: PendingSample[] = [];
  let bestRttMs = Number.POSITIVE_INFINITY;

  const requestSamples = (): void => {
    pending.length = 0;
    bestRttMs = Number.POSITIVE_INFINITY;
    for (let index = 0; index < TIME_SYNC_SAMPLE_COUNT; index += 1) {
      const clientTimestamp = now();
      pending.push({ clientTimestamp, sentAtMs: clientTimestamp });
      try {
        send(JSON.stringify({ type: "time_sync_request", clientTimestamp }));
      } catch {
        pending.pop();
      }
    }
  };

  const accept = (message: TimeSyncMessage, receivedAtMs: number): void => {
    const pendingIndex = pending.findIndex(({ clientTimestamp }) => clientTimestamp === message.clientTimestamp);
    if (pendingIndex === -1) return;
    const sample = pending.splice(pendingIndex, 1)[0];
    if (sample === undefined) return;
    const rttMs = receivedAtMs - sample.sentAtMs;
    const offsetMs = calculateTimeSyncOffset(sample.sentAtMs, receivedAtMs, message.serverTime);
    if (offsetMs === null || rttMs < 0 || rttMs >= bestRttMs) return;
    bestRttMs = rttMs;
    onOffset(offsetMs);
  };

  const reset = (): void => {
    pending.length = 0;
    bestRttMs = Number.POSITIVE_INFINITY;
  };

  return { requestSamples, accept, reset };
};
