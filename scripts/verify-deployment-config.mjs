import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseEnv } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "..");
const deploymentBindings = [
  "TWITCH_CLIENT_ID",
  "TWITCH_CLIENT_SECRET",
  "BROADCASTER_ID",
  "PUBLIC_ORIGIN",
  "CAPSULE_ID",
  "CAPSULE_NAME",
  "TIMEZONE",
  "SESSION_COOKIE_KEYS",
  "SESSION_ENCRYPTION_KEYS",
  "OVERLAY_TOKEN_PEPPER",
];
const deploymentBindingSet = new Set(deploymentBindings);
const placeholderPattern = /replace-with|example\.invalid/i;

const readSourceConfig = async () => JSON.parse(
  await readFile(path.join(projectRoot, "wrangler.jsonc"), "utf8"),
);

const validateGeneratedBuild = async (environment, generatedFile) => {
  const failures = [];
  const redirectPath = path.join(projectRoot, ".wrangler", "deploy", "config.json");

  try {
    let generatedPath;
    if (generatedFile === undefined) {
      const redirect = JSON.parse(await readFile(redirectPath, "utf8"));
      if (typeof redirect.configPath !== "string" || redirect.configPath.length === 0) {
        failures.push("Wrangler-Weiterleitung enthält keinen configPath.");
      } else {
        generatedPath = path.resolve(path.dirname(redirectPath), redirect.configPath);
      }
    } else {
      generatedPath = path.resolve(projectRoot, generatedFile);
    }

    if (generatedPath !== undefined) {
      const generated = JSON.parse(await readFile(generatedPath, "utf8"));
      const source = await readSourceConfig();
      const expected = source.env?.[environment];

      if (expected === undefined) {
        failures.push(`Wrangler-Umgebung fehlt: ${environment}`);
      } else {
        if (generated.name !== expected.name) {
          failures.push(`Worker-Name entspricht nicht der Umgebung ${environment}.`);
        }
        for (const name of ["APP_ENV", "RELEASE_STAGE"]) {
          if (generated.vars?.[name] !== expected.vars?.[name]) {
            failures.push(`${name} entspricht nicht der Umgebung ${environment}.`);
          }
        }

        const leakedBindings = deploymentBindings.filter(
          (name) => generated.vars?.[name] !== undefined,
        );
        if (leakedBindings.length > 0) {
          failures.push(
            `Private Bindings wurden als Klartext-Variablen gebaut: ${leakedBindings.join(", ")}`,
          );
        }

        const required = new Set(generated.secrets?.required ?? []);
        const missingRequired = deploymentBindings.filter((name) => !required.has(name));
        if (missingRequired.length > 0) {
          failures.push(`Erforderliche Secret-Bindings fehlen: ${missingRequired.join(", ")}`);
        }
      }
    }
  } catch (error) {
    failures.push(
      `Generierte Wrangler-Konfiguration konnte nicht gelesen werden: ${
        error instanceof Error ? error.message : "unbekannter Fehler"
      }`,
    );
  }

  if (failures.length > 0) {
    console.error(
      `Build ist nicht für ${environment} deploybar:\n` +
      failures.map((failure) => `- ${failure}`).join("\n"),
    );
    return false;
  }

  console.log(`Verified generated ${environment} Worker build.`);
  return true;
};

const readKeyring = (name, value, failures) => {
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.active?.id !== "string" ||
      parsed.active.id.length === 0 ||
      typeof parsed.active?.key !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.active.key)
    ) {
      failures.push(`${name} ist kein gültiger aktiver Keyring.`);
      return null;
    }
    return parsed.active.key;
  } catch {
    failures.push(`${name} ist kein gültiges JSON-Keyring.`);
    return null;
  }
};

const validateDeploymentValues = (environment, values) => {
  const failures = [];
  const missing = deploymentBindings.filter((name) => (values[name] ?? "").trim() === "");
  if (missing.length > 0) failures.push(`Werte fehlen: ${missing.join(", ")}`);

  const placeholders = deploymentBindings.filter((name) => {
    const value = values[name];
    return value !== undefined && (placeholderPattern.test(value) || /^0+$/.test(value));
  });
  if (placeholders.length > 0) {
    failures.push(`Platzhalterwerte sind nicht erlaubt: ${placeholders.join(", ")}`);
  }

  const unexpected = Object.keys(values).filter((name) => !deploymentBindingSet.has(name));
  if (unexpected.length > 0) failures.push(`Unerwartete Werte: ${unexpected.join(", ")}`);

  if (values.BROADCASTER_ID !== undefined && !/^[1-9]\d{0,29}$/.test(values.BROADCASTER_ID)) {
    failures.push(
      "BROADCASTER_ID muss eine positive Dezimalzeichenkette sein. Zum Ermitteln: " +
      "node scripts/resolve-broadcaster-id.mjs <login> [env-datei]",
    );
  }
  if (values.PUBLIC_ORIGIN !== undefined) {
    try {
      const origin = new URL(values.PUBLIC_ORIGIN);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== values.PUBLIC_ORIGIN ||
        origin.username !== "" ||
        origin.password !== ""
      ) {
        failures.push("PUBLIC_ORIGIN muss ein reiner HTTPS-Origin ohne Pfad oder Zugangsdaten sein.");
      }
    } catch {
      failures.push("PUBLIC_ORIGIN ist keine gültige URL.");
    }
  }
  if (
    values.CAPSULE_ID !== undefined &&
    !/^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/.test(values.CAPSULE_ID)
  ) {
    failures.push("CAPSULE_ID muss ein stabiler, kleingeschriebener Slug sein.");
  }
  if (
    values.CAPSULE_NAME !== undefined &&
    (values.CAPSULE_NAME.trim().length === 0 || values.CAPSULE_NAME.length > 80)
  ) {
    failures.push("CAPSULE_NAME muss zwischen 1 und 80 Zeichen lang sein.");
  }
  if (values.TIMEZONE !== undefined) {
    try {
      new Intl.DateTimeFormat("de-DE", { timeZone: values.TIMEZONE }).format();
    } catch {
      failures.push("TIMEZONE ist keine unterstützte IANA-Zeitzone.");
    }
  }
  if (
    values.OVERLAY_TOKEN_PEPPER !== undefined &&
    !/^[A-Za-z0-9_-]{43}$/.test(values.OVERLAY_TOKEN_PEPPER)
  ) {
    failures.push("OVERLAY_TOKEN_PEPPER muss ein 32-Byte-Base64url-Wert sein.");
  }

  const cookieKey = values.SESSION_COOKIE_KEYS === undefined
    ? null
    : readKeyring("SESSION_COOKIE_KEYS", values.SESSION_COOKIE_KEYS, failures);
  const encryptionKey = values.SESSION_ENCRYPTION_KEYS === undefined
    ? null
    : readKeyring("SESSION_ENCRYPTION_KEYS", values.SESSION_ENCRYPTION_KEYS, failures);
  if (cookieKey !== null && encryptionKey !== null && cookieKey === encryptionKey) {
    failures.push("Cookie- und Encryption-Keyring müssen unterschiedliche aktive Schlüssel nutzen.");
  }
  if (
    values.OVERLAY_TOKEN_PEPPER !== undefined &&
    (values.OVERLAY_TOKEN_PEPPER === cookieKey || values.OVERLAY_TOKEN_PEPPER === encryptionKey)
  ) {
    failures.push("OVERLAY_TOKEN_PEPPER muss unabhängig von den Session-Schlüsseln sein.");
  }

  if (failures.length > 0) {
    console.error(
      `Deploymentwerte für ${environment} sind ungültig:\n` +
      failures.map((failure) => `- ${failure}`).join("\n"),
    );
    return false;
  }
  console.log(`Verified private ${environment} deployment values.`);
  return true;
};

const command = process.argv[2];
if (command === "validate-env") {
  const environment = process.argv[3];
  const relativeFile = process.argv[4];
  if (!(["staging", "production"].includes(environment ?? "")) || relativeFile === undefined) {
    console.error("Aufruf: verify-deployment-config.mjs validate-env <staging|production> <datei>");
    process.exitCode = 2;
  } else {
    try {
      const values = parseEnv(await readFile(path.resolve(projectRoot, relativeFile), "utf8"));
      if (!validateDeploymentValues(environment, values)) process.exitCode = 1;
    } catch (error) {
      console.error(
        `Deploymentdatei für ${environment} konnte nicht gelesen werden: ` +
        (error instanceof Error ? error.message : "unbekannter Fehler"),
      );
      process.exitCode = 1;
    }
  }
} else if (command === "validate-build") {
  const environment = process.argv[3];
  const generatedFile = process.argv[4];
  if (!(environment === "staging" || environment === "production")) {
    console.error(
      "Aufruf: verify-deployment-config.mjs validate-build <staging|production> [generierte-datei]",
    );
    process.exitCode = 2;
  } else if (!await validateGeneratedBuild(environment, generatedFile)) {
    process.exitCode = 1;
  }
} else if (command !== undefined) {
  console.error(`Unbekannter Prüfmodus: ${command}`);
  process.exitCode = 2;
} else {
  const failures = [];

  const config = await readSourceConfig();

  const committedLocalBindings = Object.keys(config.vars ?? {})
    .filter((name) => deploymentBindingSet.has(name));
  if (committedLocalBindings.length > 0) {
    failures.push(
      `local: deploymentspezifische Werte stehen unter vars: ${committedLocalBindings.join(", ")}`,
    );
  }
  const requiredLocal = new Set(config.secrets?.required ?? []);
  const missingRequiredLocal = deploymentBindings.filter((name) => !requiredLocal.has(name));
  if (missingRequiredLocal.length > 0) {
    failures.push(`local: erforderliche Bindings fehlen: ${missingRequiredLocal.join(", ")}`);
  }

  try {
    const localExample = parseEnv(
      await readFile(path.join(projectRoot, ".dev.vars.example"), "utf8"),
    );
    const missingLocalExample = deploymentBindings.filter(
      (name) => localExample[name] === undefined,
    );
    if (missingLocalExample.length > 0) {
      failures.push(
        `.dev.vars.example: Beispielwerte fehlen: ${missingLocalExample.join(", ")}`,
      );
    }
  } catch (error) {
    failures.push(
      `.dev.vars.example: ${
        error instanceof Error ? error.message : "konnte nicht gelesen werden"
      }`,
    );
  }

  for (const environment of ["staging", "production"]) {
    const environmentConfig = config.env?.[environment];
    if (environmentConfig === undefined) {
      failures.push(`Wrangler-Umgebung fehlt: ${environment}`);
      continue;
    }

    const committedDeploymentBindings = Object.keys(environmentConfig.vars ?? {})
      .filter((name) => deploymentBindingSet.has(name));
    if (committedDeploymentBindings.length > 0) {
      failures.push(
        `${environment}: deploymentspezifische Werte stehen unter vars: ${committedDeploymentBindings.join(", ")}`,
      );
    }

    const required = new Set(environmentConfig.secrets?.required ?? []);
    const missingRequired = deploymentBindings.filter((name) => !required.has(name));
    if (missingRequired.length > 0) {
      failures.push(`${environment}: erforderliche Bindings fehlen: ${missingRequired.join(", ")}`);
    }

    const exampleName = `.env.${environment}.example`;
    try {
      const example = parseEnv(await readFile(path.join(projectRoot, exampleName), "utf8"));
      const missingExample = deploymentBindings.filter((name) => example[name] === undefined);
      if (missingExample.length > 0) {
        failures.push(`${exampleName}: Beispielwerte fehlen: ${missingExample.join(", ")}`);
      }
    } catch (error) {
      failures.push(
        `${exampleName}: ${error instanceof Error ? error.message : "konnte nicht gelesen werden"}`,
      );
    }

    const privateName = `.env.${environment}`;
    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", privateName], {
      cwd: projectRoot,
    });
    if (ignored.status !== 0) failures.push(`${privateName} wird nicht durch .gitignore geschützt.`);

    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", privateName], {
      cwd: projectRoot,
      stdio: "ignore",
    });
    if (tracked.status === 0) failures.push(`${privateName} darf nicht von Git verfolgt werden.`);
  }

  if (failures.length > 0) {
    console.error("Deployment-Konfiguration ist nicht sicher:\n" + failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Verified external staging and production deployment bindings.");
  }
}
