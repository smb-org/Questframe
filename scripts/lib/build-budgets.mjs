export const assetSizeKey = (group) => `asset:${group}`;

const readSize = async (sizeLookup, target) => {
  const size = await sizeLookup(target);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error(`Build budget size lookup returned an invalid size for ${target}.`);
  }
  return size;
};

export const collectStaticClosure = (manifest, entryKeys) => {
  const visited = new Set();
  const visit = (key) => {
    if (visited.has(key)) return;
    const entry = manifest[key];
    if (entry === undefined) throw new Error(`Build manifest entry is missing: ${key}`);
    visited.add(key);
    for (const imported of entry.imports ?? []) visit(imported);
  };
  for (const key of entryKeys) visit(key);
  return visited;
};

const sumJavaScript = async (manifest, closure, sizeLookup) => {
  const files = [...closure]
    .map((key) => manifest[key].file)
    .filter((file) => file.endsWith(".js"));
  const sizes = await Promise.all(files.map((file) => readSize(sizeLookup, file)));
  return sizes.reduce((total, size) => total + size, 0);
};

const sumCss = async (manifest, closure, sizeLookup) => {
  const files = new Set(
    [...closure].flatMap((key) => manifest[key].css ?? []),
  );
  const sizes = await Promise.all([...files].map((file) => readSize(sizeLookup, file)));
  return sizes.reduce((total, size) => total + size, 0);
};

const declarationKeys = (declaration) => {
  if (declaration.type === "variantMax") return declaration.keys;
  if (declaration.type === "exempt") {
    return declaration.keys ?? (declaration.key === undefined ? [] : [declaration.key]);
  }
  return declaration.key === undefined ? [] : [declaration.key];
};

const declarationName = (declaration) => (
  declaration.label
  ?? declaration.key
  ?? declaration.keys?.join(", ")
  ?? declaration.type
);

const readBudget = (declaration, property, required) => {
  const value = declaration[property];
  if (value === undefined) {
    if (!required) return { value: undefined };
    return {
      error: `${declaration.type} declaration "${declarationName(declaration)}" needs ${property}.`,
    };
  }
  if (!Number.isFinite(value) || value < 0) {
    return {
      error: `Build budget ${property} for ${declaration.type} declaration "${declarationName(declaration)}" must be a non-negative number.`,
    };
  }
  return { value };
};

const makeCheck = (declaration, label, actual, maximum) => ({
  declaration,
  label,
  actual,
  maximum,
  status: actual <= maximum ? "PASS" : "FAIL",
});

const makePendingCheck = (declaration, label) => ({
  declaration,
  label,
  actual: null,
  maximum: null,
  status: "PEND",
});

const validateCoverage = (manifest, declarations) => {
  const errors = [];
  const coverage = new Map();

  for (const declaration of declarations) {
    if (!["surface", "variantMax", "exempt"].includes(declaration.type)) {
      errors.push(`Unknown build budget declaration type: ${declaration.type}`);
      continue;
    }

    const keys = declarationKeys(declaration);
    if (declaration.type === "exempt" && (typeof declaration.reason !== "string" || declaration.reason.trim() === "")) {
      errors.push(`Exempt declaration for ${keys.join(", ")} needs a reason.`);
    }
    if (declaration.type === "exempt" && keys.length === 0) {
      errors.push("Exempt declaration must name at least one manifest entry.");
    }
    for (const key of keys) {
      const declarationsForKey = coverage.get(key) ?? [];
      declarationsForKey.push(declaration);
      coverage.set(key, declarationsForKey);
    }
  }

  for (const [key, entry] of Object.entries(manifest)) {
    if (!entry.isEntry && !entry.isDynamicEntry) continue;
    const declarationsForKey = coverage.get(key) ?? [];
    if (declarationsForKey.length === 0) {
      errors.push(`Uncovered manifest entry: ${key}`);
    } else if (declarationsForKey.length !== 1) {
      errors.push(`Manifest entry is covered by multiple declarations: ${key}`);
    }
  }

  return { errors, coverage };
};

const measureSurface = async (manifest, sizeLookup, declaration) => {
  const entryKey = declaration.key;
  const javascriptBudget = readBudget(declaration, "javascriptBudget", true);
  const transferBudget = readBudget(declaration, "transferBudget", false);
  const budgetErrors = [javascriptBudget.error, transferBudget.error].filter(Boolean);
  if ((declaration.transferAssets ?? []).length > 0 && declaration.transferBudget === undefined) {
    budgetErrors.push(
      `Surface declaration "${declarationName(declaration)}" declares transferAssets but has no transferBudget.`,
    );
  }
  if (budgetErrors.length > 0) {
    return {
      status: "FAIL",
      key: entryKey,
      type: declaration.type,
      error: budgetErrors.join("\n"),
    };
  }

  if (manifest[entryKey] === undefined) {
    if (declaration.optional) {
      return {
        status: "PEND",
        key: entryKey,
        type: declaration.type,
        checks: [makePendingCheck(declaration, declaration.label ?? entryKey)],
      };
    }
    return {
      status: "FAIL",
      key: entryKey,
      type: declaration.type,
      error: `Declared surface is missing from the build manifest: ${entryKey}`,
    };
  }

  const closure = collectStaticClosure(
    manifest,
    [...(declaration.staticRoots ?? []), entryKey],
  );
  const javascript = await sumJavaScript(manifest, closure, sizeLookup);
  const checks = [];
  checks.push(makeCheck(
    declaration,
    declaration.javascriptLabel ?? `${declaration.label ?? entryKey} JavaScript`,
    javascript,
    javascriptBudget.value,
  ));

  let css;
  let transfer;
  if (transferBudget.value !== undefined) {
    css = await sumCss(manifest, closure, sizeLookup);
    const assetSizes = await Promise.all(
      (declaration.transferAssets ?? []).map((group) => readSize(sizeLookup, assetSizeKey(group))),
    );
    transfer = javascript + css + assetSizes.reduce((total, size) => total + size, 0);
    checks.push(makeCheck(
      declaration,
      declaration.transferLabel ?? `${declaration.label ?? entryKey} transfer`,
      transfer,
      transferBudget.value,
    ));
  }

  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    key: entryKey,
    type: declaration.type,
    closure,
    javascript,
    css,
    transfer,
    checks,
  };
};

const measureVariantMax = async (manifest, sizeLookup, declaration) => {
  const budget = readBudget(declaration, "budget", true);
  if (budget.error) {
    return {
      status: "FAIL",
      type: declaration.type,
      keys: declaration.keys,
      error: budget.error,
    };
  }

  const presentKeys = declaration.keys.filter((key) => manifest[key] !== undefined);
  const missingKeys = declaration.keys.filter((key) => manifest[key] === undefined);
  if (presentKeys.length === 0) {
    if (declaration.optional) {
      return { status: "PEND", type: declaration.type, keys: declaration.keys };
    }
    return {
      status: "FAIL",
      type: declaration.type,
      keys: declaration.keys,
      error: `Required variantMax declaration is empty: ${declaration.label}`,
    };
  }
  if (missingKeys.length > 0) {
    return {
      status: "FAIL",
      type: declaration.type,
      keys: declaration.keys,
      error: `VariantMax manifest entries are missing: ${missingKeys.join(", ")}`,
    };
  }

  const members = await Promise.all(
    presentKeys.map(async (key) => {
      const closure = collectStaticClosure(manifest, [key]);
      const javascript = await sumJavaScript(manifest, closure, sizeLookup);
      const css = await sumCss(manifest, closure, sizeLookup);
      return { key, closure, javascript, css, total: javascript + css };
    }),
  );
  const actual = Math.max(...members.map((member) => member.total));
  const maximum = budget.value;
  const checks = [makeCheck(declaration, declaration.label, actual, maximum)];
  return {
    status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
    type: declaration.type,
    keys: declaration.keys,
    members,
    actual,
    checks,
  };
};

export const evaluateBuildBudgets = async (manifest, sizeLookup, declarations) => {
  const { errors, coverage } = validateCoverage(manifest, declarations);
  const checks = [];
  const declarationResults = [];

  for (const declaration of declarations) {
    let result;
    if (declaration.type === "surface") {
      result = await measureSurface(manifest, sizeLookup, declaration);
    } else if (declaration.type === "variantMax") {
      result = await measureVariantMax(manifest, sizeLookup, declaration);
    } else if (declaration.type === "exempt") {
      result = { status: "PASS", type: declaration.type, keys: declaration.keys ?? [declaration.key] };
    } else {
      result = { status: "FAIL", type: declaration.type };
    }
    if (result.error) errors.push(result.error);
    checks.push(...(result.checks ?? []));
    declarationResults.push(result);
  }

  return {
    ok: errors.length === 0 && checks.every((check) => check.status !== "FAIL"),
    errors,
    checks,
    declarationResults,
    coverage,
  };
};
