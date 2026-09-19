export type BuildBudgetDeclaration = {
  label?: string;
};

export declare const createBudgetDeclarations: (
  temporalKey: string,
  challengeStyleKeys: readonly string[],
  qrCodeKey: string,
) => readonly BuildBudgetDeclaration[];
