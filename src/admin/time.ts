export type LocalExpiryResolution =
  | { kind: "exact"; expiresAt: string }
  | { kind: "ambiguous"; choices: readonly { expiresAt: string; offset: string }[] }
  | { kind: "nonexistent" }
  | { kind: "invalid" };

export const resolveLocalExpiry = async (
  localDateTime: string,
  timezone: string,
): Promise<LocalExpiryResolution> => {
  try {
    const { Temporal } = await import("@js-temporal/polyfill");
    const plain = Temporal.PlainDateTime.from(localDateTime);
    const earlier = plain.toZonedDateTime(timezone, { disambiguation: "earlier" });
    const later = plain.toZonedDateTime(timezone, { disambiguation: "later" });
    const earlierMatches = Temporal.PlainDateTime.compare(earlier.toPlainDateTime(), plain) === 0;
    const laterMatches = Temporal.PlainDateTime.compare(later.toPlainDateTime(), plain) === 0;

    if (!earlierMatches || !laterMatches) return { kind: "nonexistent" };

    const earlierInstant = earlier.toInstant().toString();
    const laterInstant = later.toInstant().toString();
    if (earlierInstant === laterInstant) return { kind: "exact", expiresAt: earlierInstant };

    return {
      kind: "ambiguous",
      choices: [
        { expiresAt: earlierInstant, offset: earlier.offset },
        { expiresAt: laterInstant, offset: later.offset },
      ],
    };
  } catch {
    return { kind: "invalid" };
  }
};

export const expiryToLocalInput = async (
  expiresAt: string,
  timezone: string,
): Promise<string> => {
  const { Temporal } = await import("@js-temporal/polyfill");
  return Temporal.Instant.from(expiresAt)
    .toZonedDateTimeISO(timezone)
    .toPlainDateTime()
    .toString({ smallestUnit: "minute" });
};
