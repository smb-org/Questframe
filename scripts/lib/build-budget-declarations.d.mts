export type BuildBudgetDeclaration = {
  label?: string;
};

export declare const createBudgetDeclarations: (
  temporalKey: string,
  challengeThemeKeys: readonly string[],
  challengeStyleKeys: readonly string[],
  qrCodeKey: string,
) => readonly BuildBudgetDeclaration[];
