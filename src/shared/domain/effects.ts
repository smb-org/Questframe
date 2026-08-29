import type { ActiveEffect } from "../contracts/state";

export type EffectDefinition = {
  id: string;
  kind: "buff" | "debuff";
  name: string;
  description: string;
  iconId: string;
  suggestedMinutes: number | null;
  maxStacks: number;
};

const defineEffect = (
  id: string,
  kind: EffectDefinition["kind"],
  name: string,
  description: string,
  suggestedMinutes: number | null = null,
  maxStacks = 1,
): EffectDefinition => ({
  id,
  kind,
  name,
  description,
  iconId: id,
  suggestedMinutes,
  maxStacks,
});

export const EFFECT_CATALOG: readonly EffectDefinition[] = [
  defineEffect("buff-gestaerkt", "buff", "Gestärkt", "Bereit für das nächste Abenteuer.", 60),
  defineEffect("buff-satt", "buff", "Satt", "Eine gute Mahlzeit hält die Gruppe bei Laune.", 120),
  defineEffect("buff-ausgeruht", "buff", "Ausgeruht", "Volle Energie nach einer wohlverdienten Pause.", 180),
  defineEffect("buff-koffeinkick", "buff", "Koffeinkick", "Wacher Blick und ein etwas schnellerer Schritt.", 45),
  defineEffect("buff-rueckenwind", "buff", "Rückenwind", "Heute trägt der Wind den Abenteurer voran.", 30),
  defineEffect("buff-sonnenkind", "buff", "Sonnenkind", "Bestes Licht und gute Laune unter freiem Himmel.", 60),
  defineEffect("buff-wetterfest", "buff", "Wetterfest", "Regen und Wind können diese Tour nicht stoppen.", 120),
  defineEffect("buff-fokussiert", "buff", "Fokussiert", "Das nächste Ziel ist klar vor Augen.", 45),
  defineEffect("buff-crewpower", "buff", "Crew-Power", "Die Gruppe zieht gemeinsam an einem Strang.", null, 5),
  defineEffect("buff-glueckspilz", "buff", "Glückspilz", "Der Zufall meint es heute erstaunlich gut.", 60),
  defineEffect("buff-pfadfinder", "buff", "Pfadfinder", "Ein sicherer Weg ist bereits ausgemacht.", 90),
  defineEffect("buff-feuerwaerme", "buff", "Feuerwärme", "Das Lagerfeuer wärmt Hände und Stimmung.", 60),
  defineEffect("buff-gipfelrausch", "buff", "Gipfelrausch", "Die Aussicht macht jeden Höhenmeter vergessen.", 30),
  defineEffect("buff-proviant", "buff", "Proviant", "Vorräte sind gepackt und griffbereit.", null),
  defineEffect("buff-adrenalinschub", "buff", "Adrenalinschub", "Kurzzeitig ist noch eine Extraportion Kraft da.", 10),
  defineEffect("buff-tatendrang", "buff", "Tatendrang", "Keine Zeit verlieren – das Abenteuer wartet.", 60),
  defineEffect("buff-naturverbunden", "buff", "Naturverbunden", "Der Wald fühlt sich heute wie Zuhause an.", 120),
  defineEffect("buff-streamsegen", "buff", "Streamsegen", "Der Chat schickt Glück für den weiteren Weg.", 60),
  defineEffect("buff-heissgetraenk", "buff", "Heißgetränk", "Von innen warm und wieder einsatzbereit.", 30),
  defineEffect("buff-entdeckergeist", "buff", "Entdeckergeist", "Hinter der nächsten Kurve wartet etwas Neues.", null),
  defineEffect("debuff-hungrig", "debuff", "Hungrig", "Der nächste Verpflegungsstopp wird dringend.", null),
  defineEffect("debuff-muede", "debuff", "Müde", "Die Augen werden schwer und der Weg immer länger.", null),
  defineEffect("debuff-durstig", "debuff", "Durstig", "Die Trinkflasche sollte bald zum Einsatz kommen.", null),
  defineEffect("debuff-nasse-socken", "debuff", "Nasse Socken", "Jeder Schritt erinnert an die letzte Pfütze.", null),
  defineEffect("debuff-sonnenbrand", "debuff", "Sonnenbrand", "Die Sonne war stärker als der Schutzfaktor.", 240),
  defineEffect("debuff-muskelkater", "debuff", "Muskelkater", "Die letzte Tour steckt noch in den Beinen.", 720),
  defineEffect("debuff-verlaufen", "debuff", "Verlaufen", "Der richtige Pfad ist gerade nicht eindeutig.", null),
  defineEffect("debuff-funkloch", "debuff", "Funkloch", "Die Verbindung kämpft mit der Wildnis.", null),
  defineEffect("debuff-gegenwind", "debuff", "Gegenwind", "Jeder Meter kostet heute etwas mehr Kraft.", 60),
  defineEffect("debuff-regenschauer", "debuff", "Regenschauer", "Von oben kommt mehr Wasser als bestellt.", 30),
  defineEffect("debuff-blase-am-fuss", "debuff", "Blase am Fuß", "Der Schuh gewinnt gerade den Zweikampf.", null),
  defineEffect("debuff-schweres-gepaeck", "debuff", "Schweres Gepäck", "Der Rucksack fühlt sich mit jedem Schritt schwerer an.", null),
  defineEffect("debuff-kaelteschock", "debuff", "Kälteschock", "Ein eisiger Moment bremst den Abenteurer aus.", 15),
  defineEffect("debuff-hitzestau", "debuff", "Hitzestau", "Schatten und eine Pause wären jetzt ideal.", null),
  defineEffect("debuff-matschig", "debuff", "Matschig", "Der Untergrund klebt hartnäckig an der Ausrüstung.", null),
  defineEffect("debuff-low-battery", "debuff", "Low Battery", "Die Technik verlangt nach neuer Energie.", null),
  defineEffect("debuff-chat-vermisst", "debuff", "Chat vermisst", "Zu lange kein Blick auf die Reisebegleiter im Chat.", 20),
  defineEffect("debuff-umweg", "debuff", "Umweg", "Das Ziel rückt vorübergehend ein Stück weiter weg.", null),
  defineEffect("debuff-zeckenalarm", "debuff", "Zeckenalarm", "Zeit für einen gründlichen Ausrüstungscheck.", null),
  defineEffect("debuff-pausenbedarf", "debuff", "Pausenbedarf", "Eine kurze Rast würde gerade Wunder wirken.", null),
] as const;

export const getRemainingSeconds = (
  expiresAt: string | null,
  nowMilliseconds = Date.now(),
): number | null =>
  expiresAt === null
    ? null
    : Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMilliseconds) / 1_000));

export const formatRemainingTime = (seconds: number | null): string => {
  if (seconds === null) return "";
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainder = safeSeconds % 60;
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes)}:${String(remainder).padStart(2, "0")}`;
};

export const validateEffectExpiries = (
  nextEffects: readonly ActiveEffect[],
  previousEffects: readonly ActiveEffect[],
  nowMilliseconds = Date.now(),
): void => {
  const previousById = new Map(previousEffects.map((effect) => [effect.id, effect]));
  const minimum = nowMilliseconds + 60_000;
  const maximum = nowMilliseconds + 30 * 24 * 60 * 60 * 1_000;

  for (const effect of nextEffects) {
    if (effect.expiresAt === null) continue;
    const previous = previousById.get(effect.id);
    if (previous?.expiresAt === effect.expiresAt) continue;
    const expiry = Date.parse(effect.expiresAt);
    if (expiry < minimum) {
      throw new Error("Neue Ablaufzeiten müssen mindestens einer Minute in der Zukunft liegen.");
    }
    if (expiry > maximum) {
      throw new Error("Neue Ablaufzeiten dürfen höchstens 30 Tage in der Zukunft liegen.");
    }
  }
};

export const getEffectDefinition = (
  catalogId: string | null,
): EffectDefinition | undefined =>
  catalogId === null
    ? undefined
    : EFFECT_CATALOG.find((effect) => effect.id === catalogId);
