import type { ChannelState, PortraitRef } from "../shared/contracts/state";

type OverlayMessage =
  | { type: "snapshot" | "state_committed"; state: ChannelState }
  | { type: "token_revoked" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value).sort();
  const expected = [...keys].sort();
  return present.length === expected.length && present.every((key, index) => key === expected[index]);
};

const isText = (value: unknown, minimum: number, maximum: number): value is string =>
  typeof value === "string" && value.length >= minimum && value.length <= maximum;

const isInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;

const isPercent = (value: unknown): value is number => isInteger(value, 0, 100);

const isInstant = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

const isPortrait = (value: unknown): value is PortraitRef => {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "bundled") {
    return exactKeys(value, ["kind", "assetId"]) && isText(value.assetId, 1, 64);
  }
  if (value.kind === "uploaded") {
    return exactKeys(value, ["kind", "contentHash"]) &&
      typeof value.contentHash === "string" && /^[a-f0-9]{64}$/.test(value.contentHash);
  }
  if (value.kind === "twitch") {
    return exactKeys(value, ["kind", "userId", "url"]) &&
      typeof value.userId === "string" && /^\d+$/.test(value.userId) &&
      isText(value.url, 1, 2_048);
  }
  if (value.kind === "initials") {
    return exactKeys(value, ["kind", "text"]) && isText(value.text, 1, 4);
  }
  return false;
};

const isEffect = (value: unknown, index: number): boolean => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "id",
      "catalogId",
      "kind",
      "name",
      "description",
      "iconId",
      "stacks",
      "expiresAt",
      "order",
    ])
  ) return false;
  return isText(value.id, 1, 64) &&
    (value.catalogId === null || isText(value.catalogId, 1, 64)) &&
    (value.kind === "buff" || value.kind === "debuff") &&
    isText(value.name, 1, 24) &&
    (value.description === null || isText(value.description, 1, 90)) &&
    isText(value.iconId, 1, 64) &&
    (value.stacks === null || isInteger(value.stacks, 1, 99)) &&
    (value.expiresAt === null || isInstant(value.expiresAt)) &&
    value.order === index;
};

const isGroupMember = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["id", "source", "twitchUserId", "name", "portrait", "hpPercent"])
  ) return false;
  return isText(value.id, 1, 64) &&
    (value.source === "twitch" || value.source === "manual") &&
    (value.twitchUserId === null ||
      (typeof value.twitchUserId === "string" && /^\d+$/.test(value.twitchUserId))) &&
    isText(value.name, 1, 32) &&
    isPortrait(value.portrait) &&
    isPercent(value.hpPercent);
};

export const parseOverlayState = (input: unknown): ChannelState | null => {
  if (
    !isRecord(input) ||
    !exactKeys(input, [
      "schemaVersion",
      "revision",
      "overlayEnabled",
      "themeId",
      "placement",
      "player",
      "pet",
      "petVisible",
      "group",
      "groupVisible",
      "effects",
      "featuredEffectId",
      "updatedAt",
      "updatedBy",
    ]) ||
    input.schemaVersion !== 1 ||
    !isInteger(input.revision, 1, Number.MAX_SAFE_INTEGER) ||
    typeof input.overlayEnabled !== "boolean" ||
    typeof input.petVisible !== "boolean" ||
    typeof input.groupVisible !== "boolean" ||
    ![
      "trail-wood",
      "field-journal",
      "forged-compass",
      "classic-simple",
      "modern-compact",
      "modern-minimal",
      "classic-remix",
    ].includes(String(input.themeId))
  ) return null;

  const placement = input.placement;
  if (
    !isRecord(placement) ||
    !exactKeys(placement, ["x", "y", "scale"]) ||
    !isInteger(placement.x, 0, 384) ||
    !isInteger(placement.y, 0, 216) ||
    typeof placement.scale !== "number" ||
    placement.scale < 0.75 ||
    placement.scale > 2
  ) return null;

  const player = input.player;
  if (
    !isRecord(player) ||
    !exactKeys(player, ["name", "title", "level", "portrait", "hpPercent", "resource"]) ||
    !isText(player.name, 1, 32) ||
    !(player.title === null || isText(player.title, 1, 40)) ||
    !isInteger(player.level, 1, 999) ||
    !isPortrait(player.portrait) ||
    !isPercent(player.hpPercent)
  ) return null;
  const resource = player.resource;
  if (
    !isRecord(resource) ||
    !exactKeys(resource, ["name", "color", "percent"]) ||
    !isText(resource.name, 1, 16) ||
    typeof resource.color !== "string" ||
    !/^#[A-Fa-f0-9]{6}$/.test(resource.color) ||
    !isPercent(resource.percent)
  ) return null;

  if (input.pet !== null) {
    if (
      !isRecord(input.pet) ||
      !exactKeys(input.pet, ["name", "subtitle", "portrait", "hpPercent"]) ||
      !isText(input.pet.name, 1, 32) ||
      !(input.pet.subtitle === null || isText(input.pet.subtitle, 1, 40)) ||
      !isPortrait(input.pet.portrait) ||
      !isPercent(input.pet.hpPercent)
    ) return null;
  }
  if (!Array.isArray(input.group) || input.group.length > 5 || !input.group.every(isGroupMember)) {
    return null;
  }
  if (
    !Array.isArray(input.effects) ||
    input.effects.length > 8 ||
    !input.effects.every((effect, index) => isEffect(effect, index))
  ) return null;
  if (!(input.featuredEffectId === null || isText(input.featuredEffectId, 1, 64))) return null;
  if (input.featuredEffectId !== null) {
    const featuredIsValid = (input.effects as unknown[]).some(
      (effect) =>
        isRecord(effect) &&
        effect.id === input.featuredEffectId &&
        typeof effect.description === "string",
    );
    if (!featuredIsValid) return null;
  }
  if (!isInstant(input.updatedAt)) return null;
  if (
    !isRecord(input.updatedBy) ||
    !exactKeys(input.updatedBy, ["twitchUserId", "displayName"]) ||
    typeof input.updatedBy.twitchUserId !== "string" ||
    !/^\d+$/.test(input.updatedBy.twitchUserId) ||
    !isText(input.updatedBy.displayName, 1, 32)
  ) return null;
  return input.themeId === "classic-remix"
    ? { ...input, themeId: "trail-wood" } as ChannelState
    : input as ChannelState;
};

export const parseOverlayMessage = (input: unknown): OverlayMessage | null => {
  if (!isRecord(input) || typeof input.type !== "string") return null;
  if (input.type === "token_revoked" && exactKeys(input, ["type"])) {
    return { type: "token_revoked" };
  }
  if (
    (input.type === "snapshot" || input.type === "state_committed") &&
    exactKeys(input, ["type", "state"])
  ) {
    const state = parseOverlayState(input.state);
    return state === null ? null : { type: input.type, state };
  }
  return null;
};
