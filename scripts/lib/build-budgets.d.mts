export type ManifestEntry = {
  file: string;
  imports?: string[];
  css?: string[];
  isDynamicEntry?: boolean;
  isEntry?: boolean;
};

export type BuildManifest = Record<string, ManifestEntry>;
export type SizeLookup = (target: string) => number | Promise<number>;

export type SurfaceDeclaration = {
  type: "surface";
  key: string;
  label?: string;
  staticRoots?: string[];
  javascriptLabel?: string;
  javascriptBudget: number;
  transferLabel?: string;
  transferBudget?: number;
  transferAssets?: string[];
  optional?: boolean;
};

export type VariantMaxDeclaration = {
  type: "variantMax";
  label: string;
  keys: string[];
  budget: number;
  optional?: boolean;
};

export type ExemptDeclaration =
  | { type: "exempt"; key: string; keys?: never; reason: string }
  | { type: "exempt"; key?: never; keys: [string, ...string[]]; reason: string };

export type BuildBudgetDeclaration = SurfaceDeclaration | VariantMaxDeclaration | ExemptDeclaration;
export type BuildBudgetStatus = "PASS" | "FAIL" | "PEND";

export type BuildBudgetCheck = {
  declaration: BuildBudgetDeclaration;
  label: string;
  actual: number | null;
  maximum: number | null;
  status: BuildBudgetStatus;
};

export type BuildBudgetResult = {
  ok: boolean;
  errors: string[];
  checks: BuildBudgetCheck[];
  declarationResults: Array<{ status: BuildBudgetStatus; [key: string]: unknown }>;
  coverage: Map<string, BuildBudgetDeclaration[]>;
};

export declare const assetSizeKey: (group: string) => string;
export declare const collectStaticClosure: (manifest: BuildManifest, entryKeys: string[]) => Set<string>;
export declare const evaluateBuildBudgets: (
  manifest: BuildManifest,
  sizeLookup: SizeLookup,
  declarations: BuildBudgetDeclaration[],
) => Promise<BuildBudgetResult>;
