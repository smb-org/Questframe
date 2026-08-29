import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

const projectRoot = path.resolve(import.meta.dirname, "..");
const loginPattern = /^[a-zA-Z0-9_]{4,25}$/;
const placeholderPattern = /^(replace-with|SET_)/;

const usage = () =>
  console.error(
    "Aufruf: node scripts/resolve-broadcaster-id.mjs <login> [env-datei]\n" +
    "  <login>     Twitch-Benutzername (Login), 4 bis 25 Zeichen aus [a-zA-Z0-9_]\n" +
    "  [env-datei] Optional, Standard .dev.vars (z.B. .env.staging oder .env.production)",
  );

const login = process.argv[2];
const relativeEnvFile = process.argv[3] ?? ".dev.vars";

if (login === undefined || !loginPattern.test(login)) {
  console.error("Ungültiger oder fehlender Twitch-Login.");
  usage();
  process.exit(2);
}

const envFile = path.resolve(projectRoot, relativeEnvFile);

let values;
try {
  values = parseEnv(await readFile(envFile, "utf8"));
} catch (error) {
  console.error(
    `Env-Datei konnte nicht gelesen werden: ${relativeEnvFile}\n` +
    (error instanceof Error ? error.message : "unbekannter Fehler"),
  );
  process.exit(2);
}

const clientId = values.TWITCH_CLIENT_ID;
const clientSecret = values.TWITCH_CLIENT_SECRET;

const missingOrPlaceholder = [];
if (!clientId || clientId.trim() === "" || placeholderPattern.test(clientId)) {
  missingOrPlaceholder.push("TWITCH_CLIENT_ID");
}
if (!clientSecret || clientSecret.trim() === "" || placeholderPattern.test(clientSecret)) {
  missingOrPlaceholder.push("TWITCH_CLIENT_SECRET");
}

if (missingOrPlaceholder.length > 0) {
  console.error(
    `In ${relativeEnvFile} fehlen gültige Werte für: ${missingOrPlaceholder.join(", ")}.\n` +
    "Trage dort echte Twitch-App-Zugangsdaten ein (keine Platzhalter), bevor dieses Skript " +
    "einen Netzaufruf an Twitch macht.",
  );
  process.exit(1);
}

let tokenResponse;
try {
  tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
} catch (error) {
  console.error(
    "Netzaufruf zu id.twitch.tv fehlgeschlagen: " +
    (error instanceof Error ? error.message : "unbekannter Fehler"),
  );
  process.exit(1);
}

if (!tokenResponse.ok) {
  let message = `HTTP ${tokenResponse.status}`;
  try {
    const body = await tokenResponse.json();
    if (typeof body?.message === "string") message += `: ${body.message}`;
  } catch {
    // Antwort war kein JSON; nur den Statuscode melden.
  }
  console.error(`Twitch hat den App Access Token abgelehnt (${message}).`);
  process.exit(1);
}

let tokenBody;
try {
  tokenBody = await tokenResponse.json();
} catch {
  console.error("Antwort von id.twitch.tv war kein gültiges JSON.");
  process.exit(1);
}

const accessToken = tokenBody?.access_token;
if (typeof accessToken !== "string" || accessToken.length === 0) {
  console.error("Antwort von id.twitch.tv enthielt keinen access_token.");
  process.exit(1);
}

let usersResponse;
try {
  usersResponse = await fetch(
    `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
    {
      headers: {
        "client-id": clientId,
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
} catch (error) {
  console.error(
    "Netzaufruf zu api.twitch.tv fehlgeschlagen: " +
    (error instanceof Error ? error.message : "unbekannter Fehler"),
  );
  process.exit(1);
}

if (!usersResponse.ok) {
  let message = `HTTP ${usersResponse.status}`;
  try {
    const body = await usersResponse.json();
    if (typeof body?.message === "string") message += `: ${body.message}`;
  } catch {
    // Antwort war kein JSON; nur den Statuscode melden.
  }
  console.error(`Twitch hat die Benutzerabfrage abgelehnt (${message}).`);
  process.exit(1);
}

let usersBody;
try {
  usersBody = await usersResponse.json();
} catch {
  console.error("Antwort von api.twitch.tv war kein gültiges JSON.");
  process.exit(1);
}

if (!Array.isArray(usersBody?.data) || usersBody.data.length === 0) {
  console.error(`Es gibt bei Twitch keinen Benutzer mit dem Login "${login}".`);
  process.exit(1);
}

const user = usersBody.data[0];
if (typeof user?.id !== "string" || user.id.length === 0) {
  console.error("Antwort von api.twitch.tv enthielt keine gültige Benutzer-ID.");
  process.exit(1);
}

console.log(`Anzeigename: ${user.display_name ?? "(unbekannt)"}`);
console.log(`Login: ${user.login ?? login}`);
console.log("");
console.log(`BROADCASTER_ID=${user.id}`);
console.log("");
console.log(
  "Hinweis: Dieser Wert muss danach stabil bleiben. Eine spätere Änderung adressiert " +
  "absichtlich ein anderes Durable Object und entwertet alle bestehenden Sessions.",
);
process.exit(0);
