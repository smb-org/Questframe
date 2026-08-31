export const isStateBearingMessage = (input: unknown): boolean =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  ((input as { type?: unknown }).type === "snapshot" ||
    (input as { type?: unknown }).type === "state_committed");
