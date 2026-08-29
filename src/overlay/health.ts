export type HealthTier = "healthy" | "warning" | "critical";

export const getHealthTier = (percent: number): HealthTier =>
  percent < 20 ? "critical" : percent < 50 ? "warning" : "healthy";
