import {
  Activity,
  ChevronDown,
  Clock3,
  Copy,
  Eye,
  EyeOff,
  ImagePlus,
  LogOut,
  MessageSquare,
  PawPrint,
  Plus,
  Radio,
  RotateCw,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Users,
  Wifi,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type ReactNode,
} from "react";

import type {
  BootstrapResponse,
  OverlayTokenResponse,
  SaveRequest,
  SaveResponse,
} from "../shared/contracts/api";
import type {
  ActiveEffect,
  ChannelState,
  ChannelStateDraft,
  GroupMember,
  PortraitRef,
} from "../shared/contracts/state";
import { EFFECT_CATALOG, type EffectDefinition } from "../shared/domain/effects";
import { HudRenderer } from "../overlay/HudRenderer";
import { expiryToLocalInput, resolveLocalExpiry } from "./time";
import "./admin.css";

export type AdminApi = {
  save: (request: SaveRequest) => Promise<SaveResponse>;
  setVisibility: (enabled: boolean) => Promise<{
    state: ChannelState;
    auditEntry: BootstrapResponse["recentAudit"][number] | null;
    undoTargets: BootstrapResponse["undoTargets"];
    serverTime: string;
  }>;
  undo?: ((baseRevision: number, targetRevision: number) => Promise<SaveResponse>) | undefined;
  mutateOverlayToken?:
    | ((rotate: boolean, request: {
        requestId: string;
        expectedGeneration: number;
        candidateToken: string;
      }) => Promise<OverlayTokenResponse>)
    | undefined;
  uploadPortrait?: ((blob: Blob) => Promise<PortraitRef>) | undefined;
  renewMediaLeases?: ((contentHashes: string[]) => Promise<void>) | undefined;
  lookupTwitchUser?:
    | ((login: string) => Promise<{
        id: string;
        login: string;
        displayName: string;
        profileImageUrl: string;
      }>)
    | undefined;
  subscribe?:
    | ((callbacks: {
        onState: (state: ChannelState) => void;
        onOnlineChange: (online: boolean) => void;
        onOverlayPresence: (connectedSockets: number) => void;
      }) => () => void)
    | undefined;
  logout?: (() => Promise<void>) | undefined;
};

const toDraft = (state: ChannelState): ChannelStateDraft => {
  const {
    revision: _revision,
    overlayEnabled: _overlayEnabled,
    updatedAt: _updatedAt,
    updatedBy: _updatedBy,
    ...draft
  } = state;
  void [_revision, _overlayEnabled, _updatedAt, _updatedBy];
  return draft;
};

const uploadedHashes = (state: ChannelStateDraft | ChannelState): string[] => {
  const portraits = [
    state.player.portrait,
    state.pet?.portrait,
    ...state.group.map((member) => member.portrait),
  ];
  return [
    ...new Set(
      portraits.flatMap((portrait) =>
        portrait?.kind === "uploaded" ? [portrait.contentHash] : [],
      ),
    ),
  ];
};

// Kapselt den Sekundentakt der Vorschau, damit nicht die gesamte Konsole
// jede Sekunde neu rendert, während jemand tippt.
const TickingPreview = (props: Omit<ComponentProps<typeof HudRenderer>, "nowMilliseconds">) => {
  const [nowMilliseconds, setNowMilliseconds] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMilliseconds(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return <HudRenderer {...props} nowMilliseconds={nowMilliseconds} />;
};

const toPreview = (draft: ChannelStateDraft, committed: ChannelState): ChannelState => ({
  ...draft,
  revision: committed.revision,
  overlayEnabled: committed.overlayEnabled,
  updatedAt: committed.updatedAt,
  updatedBy: committed.updatedBy,
});

const randomBase64UrlToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

type EffectFlyoverProps = {
  effect?: ActiveEffect | undefined;
  initialFeatured: boolean;
  timezone: string;
  onClose: () => void;
  onCommit: (effect: ActiveEffect, featured: boolean) => void;
};

const EffectFlyover = ({ effect, initialFeatured, timezone, onClose, onCommit }: EffectFlyoverProps) => {
  const initialDefinition = EFFECT_CATALOG.find((item) => item.id === effect?.catalogId);
  const [kind, setKind] = useState<"all" | "buff" | "debuff">("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<EffectDefinition | null>(initialDefinition ?? null);
  const [name, setName] = useState(effect?.name ?? initialDefinition?.name ?? "");
  const [description, setDescription] = useState(effect?.description ?? initialDefinition?.description ?? "");
  const [timed, setTimed] = useState(effect?.expiresAt !== null && effect?.expiresAt !== undefined);
  const [expiresLocal, setExpiresLocal] = useState("");
  const [featured, setFeatured] = useState(initialFeatured);
  const [ambiguousChoices, setAmbiguousChoices] = useState<readonly { expiresAt: string; offset: string }[]>([]);
  const [selectedInstant, setSelectedInstant] = useState("");
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState("");
  const [openedAt] = useState(() => Date.now());
  const filtered = EFFECT_CATALOG.filter(
    (item) =>
      (kind === "all" || item.kind === kind) &&
      item.name.toLocaleLowerCase("de").includes(query.toLocaleLowerCase("de")),
  );

  useEffect(() => {
    if (effect?.expiresAt === null || effect?.expiresAt === undefined) return;
    void expiryToLocalInput(effect.expiresAt, timezone).then(setExpiresLocal).catch(() => {
      setError("Die gespeicherte Ablaufzeit konnte nicht gelesen werden.");
    });
  }, [effect?.expiresAt, timezone]);

  const choose = (definition: EffectDefinition) => {
    setSelected(definition);
    setName(definition.name);
    setDescription(definition.description);
    if (definition.suggestedMinutes !== null) {
      setTimed(true);
      void expiryToLocalInput(
        new Date(openedAt + definition.suggestedMinutes * 60_000).toISOString(),
        timezone,
      ).then(setExpiresLocal);
    } else {
      setTimed(false);
      setExpiresLocal("");
    }
  };

  const commit = async () => {
    if (selected === null && effect === undefined) {
      setError("Bitte zuerst einen Effekt auswählen.");
      return;
    }
    if (name.trim() === "") {
      setError("Der Effekt braucht einen Namen.");
      return;
    }
    if (featured && description.trim() === "") {
      setError("Für die sichtbare Beschreibung fehlt Text.");
      return;
    }
    let expiresAt: string | null = null;
    if (timed) {
      setResolving(true);
      const resolution = await resolveLocalExpiry(expiresLocal, timezone);
      setResolving(false);
      if (resolution.kind === "invalid") {
        setError("Bitte eine gültige absolute Uhrzeit wählen.");
        return;
      }
      if (resolution.kind === "nonexistent") {
        setError(`Diese Uhrzeit existiert in ${timezone} nicht (Zeitumstellung).`);
        return;
      }
      if (resolution.kind === "ambiguous") {
        setAmbiguousChoices(resolution.choices);
        if (!resolution.choices.some((choice) => choice.expiresAt === selectedInstant)) {
          setError("Diese Uhrzeit kommt zweimal vor. Bitte Sommer- oder Winterzeit wählen.");
          return;
        }
        expiresAt = selectedInstant;
      } else {
        expiresAt = resolution.expiresAt;
      }
    }
    const definition = selected ?? initialDefinition;
    onCommit(
      {
        id: effect?.id ?? crypto.randomUUID(),
        catalogId: definition?.id ?? null,
        kind: definition?.kind ?? effect?.kind ?? "buff",
        name: name.trim(),
        description: description.trim() === "" ? null : description.trim(),
        iconId: definition?.iconId ?? effect?.iconId ?? "buff-gestaerkt",
        stacks: effect?.stacks ?? null,
        expiresAt,
        order: effect?.order ?? 0,
      },
      featured,
    );
  };

  return (
    <div className="effect-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-label={effect === undefined ? "Effekt hinzufügen" : "Effekt bearbeiten"}
        aria-modal="true"
        className="effect-flyover"
        role="dialog"
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
      >
        <header className="effect-flyover-header">
          <div>
            <span className="eyebrow">Effekt-Slot</span>
            <h2>{effect === undefined ? "Effekt hinzufügen" : "Effekt bearbeiten"}</h2>
          </div>
          <button className="icon-button" aria-label="Schließen" onClick={onClose} type="button">
            <X size={18} />
          </button>
        </header>
        <div className="effect-tabs" role="tablist" aria-label="Effekttyp">
          {(["all", "buff", "debuff"] as const).map((tab) => (
            <button
              aria-selected={kind === tab}
              className={kind === tab ? "is-active" : ""}
              key={tab}
              onClick={() => setKind(tab)}
              role="tab"
              type="button"
            >
              {tab === "all" ? "Alle" : tab === "buff" ? "Buffs" : "Debuffs"}
            </button>
          ))}
        </div>
        <label className="search-field">
          <Search size={16} />
          <span className="sr-only">Effekt suchen</span>
          <input
            placeholder="Effekt suchen …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="effect-catalog">
          {filtered.map((definition) => (
            <button
              className={selected?.id === definition.id ? "effect-tile is-selected" : "effect-tile"}
              key={definition.id}
              onClick={() => choose(definition)}
              type="button"
            >
              <img alt="" src={`/assets/effects/${definition.iconId}.webp`} />
              <span>{definition.name}</span>
            </button>
          ))}
        </div>
        <div className="effect-form">
          <label>
            <span>Name</span>
            <input maxLength={24} value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>Beschreibung (optional)</span>
            <textarea
              maxLength={90}
              rows={2}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="check-row">
            <input
              checked={timed}
              onChange={(event) => setTimed(event.target.checked)}
              type="checkbox"
            />
            <span>Endet zu einer festen Uhrzeit</span>
          </label>
          {timed && (
            <label>
              <span>Endet am · {timezone}</span>
              <input
                type="datetime-local"
                value={expiresLocal}
                onChange={(event) => {
                  setExpiresLocal(event.target.value);
                  setAmbiguousChoices([]);
                  setSelectedInstant("");
                  setError("");
                }}
              />
            </label>
          )}
          {ambiguousChoices.length > 0 && (
            <fieldset className="dst-choices">
              <legend>Zeitumstellung wählen</legend>
              {ambiguousChoices.map((choice) => (
                <label className="check-row" key={choice.expiresAt}>
                  <input
                    checked={selectedInstant === choice.expiresAt}
                    name="dst-instant"
                    type="radio"
                    value={choice.expiresAt}
                    onChange={() => {
                      setSelectedInstant(choice.expiresAt);
                      setError("");
                    }}
                  />
                  <span>UTC{choice.offset}</span>
                </label>
              ))}
            </fieldset>
          )}
          <label className="check-row">
            <input
              checked={featured}
              onChange={(event) => setFeatured(event.target.checked)}
              type="checkbox"
            />
            <span>Beschreibung im Overlay anzeigen</span>
          </label>
          {error !== "" && <p className="field-error" role="alert">{error}</p>}
        </div>
        <footer className="effect-actions">
          <button className="button button--quiet" onClick={onClose} type="button">Abbrechen</button>
          <button className="button button--primary" disabled={resolving} onClick={() => void commit()} type="button">
            {resolving ? "Prüfe Uhrzeit …" : effect === undefined ? "Hinzufügen" : "Übernehmen"}
          </button>
        </footer>
      </section>
    </div>
  );
};

const Section = ({
  icon,
  title,
  children,
  defaultOpen = true,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) => (
  <details className="editor-section" open={defaultOpen}>
    <summary>
      <span className="section-icon">{icon}</span>
      <span>{title}</span>
      <ChevronDown className="section-chevron" size={17} />
    </summary>
    <div className="editor-section-body">{children}</div>
  </details>
);

const RangeField = ({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) => (
  <label className="range-field">
    <span className="range-label">
      <span>{label}</span>
      <strong>{value}%</strong>
    </span>
    <input
      aria-label={label}
      disabled={disabled}
      max={100}
      min={0}
      type="range"
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  </label>
);

const encodePortrait = async (file: File): Promise<Blob> => {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const target = Math.min(512, Math.max(32, side));
  const canvas = document.createElement("canvas");
  canvas.width = target;
  canvas.height = target;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Bildverarbeitung nicht verfügbar.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    target,
    target,
  );
  bitmap.close();
  for (const quality of [0.9, 0.78, 0.64, 0.5]) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, "image/webp", quality);
    });
    if (blob !== null && blob.size <= 262_144) return blob;
  }
  throw new Error("Das optimierte Portrait ist noch größer als 256 KiB.");
};

const PortraitInput = ({
  disabled,
  upload,
  onPortrait,
}: {
  disabled: boolean;
  upload?: AdminApi["uploadPortrait"];
  onPortrait: (portrait: PortraitRef) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const change = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file === undefined || upload === undefined) return;
    setBusy(true);
    setError("");
    try {
      onPortrait(await upload(await encodePortrait(file)));
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message.trim() !== ""
          ? caught.message
          : "Portrait konnte nicht verarbeitet werden.",
      );
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };
  return (
    <div className="portrait-input">
      <label className="button button--quiet">
        <ImagePlus size={15} />
        <span>{busy ? "Wird optimiert …" : "Portrait hochladen"}</span>
        <input accept="image/*" disabled={disabled || busy} onChange={(event) => void change(event)} type="file" />
      </label>
      {error !== "" && <span className="field-error">{error}</span>}
    </div>
  );
};

export const AdminWorkspace = ({
  initialBootstrap,
  api,
}: {
  initialBootstrap: BootstrapResponse;
  api: AdminApi;
}) => {
  const [committed, setCommitted] = useState(initialBootstrap.state);
  const [draft, setDraft] = useState(() => toDraft(initialBootstrap.state));
  const [draftBaseRevision, setDraftBaseRevision] = useState(initialBootstrap.state.revision);
  const [audit, setAudit] = useState(initialBootstrap.recentAudit);
  const [undoTargets, setUndoTargets] = useState(initialBootstrap.undoTargets);
  const [online, setOnline] = useState(true);
  const [saving, setSaving] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [remoteConflict, setRemoteConflict] = useState<ChannelState | null>(null);
  const [effectEditor, setEffectEditor] = useState<ActiveEffect | "new" | null>(null);
  const [manualGuestName, setManualGuestName] = useState("");
  const [twitchLogin, setTwitchLogin] = useState("");
  const [guestBusy, setGuestBusy] = useState(false);
  const [overlayToken, setOverlayToken] = useState(initialBootstrap.capsule.overlayToken);
  const [obsUrl, setObsUrl] = useState(() => sessionStorage.getItem("irl-stream-hud-obs-url") ?? "");
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(toDraft(committed)),
    [committed, draft],
  );
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const preview = toPreview(draft, committed);
  const previewMediaUrls = useMemo(() => {
    const portraits = [
      draft.player.portrait,
      draft.pet?.portrait,
      ...draft.group.map((member) => member.portrait),
    ];
    return new Map(
      portraits.flatMap((portrait) =>
        portrait?.kind === "uploaded"
          ? [[portrait.contentHash, `/api/media/${portrait.contentHash}`] as const]
          : [],
      ),
    );
  }, [draft.group, draft.pet?.portrait, draft.player.portrait]);
  const locked = saving || !online;
  const uploadPortrait = api.uploadPortrait?.bind(api);

  useEffect(() => {
    if (api.subscribe === undefined) return;
    return api.subscribe({
      onState: (state) => {
        setCommitted((previous) => {
          if (state.revision <= previous.revision) return previous;
          const contentChanged = JSON.stringify(toDraft(state)) !== JSON.stringify(toDraft(previous));
          if (dirtyRef.current && contentChanged) {
            setRemoteConflict(state);
          } else {
            if (!dirtyRef.current) setDraft(toDraft(state));
            setDraftBaseRevision(state.revision);
            setRemoteConflict(null);
          }
          return state;
        });
      },
      onOnlineChange: setOnline,
      onOverlayPresence: (connectedSockets) => {
        setOverlayToken((current) => ({ ...current, connectedSockets }));
      },
    });
  }, [api]);

  const pendingLeaseHashes = useMemo(() => {
    const committedHashes = new Set(uploadedHashes(committed));
    return uploadedHashes(draft).filter((hash) => !committedHashes.has(hash));
  }, [committed, draft]);
  const pendingLeaseHashesRef = useRef(pendingLeaseHashes);
  useEffect(() => {
    pendingLeaseHashesRef.current = pendingLeaseHashes;
  }, [pendingLeaseHashes]);

  // Das Intervall haengt bewusst nur an der API: der Draft aendert sich bei jedem
  // Tastendruck, eine Abhaengigkeit darauf wuerde den Timer endlos neu starten.
  useEffect(() => {
    if (api.renewMediaLeases === undefined) return;
    const renewFn = api.renewMediaLeases;
    const timer = window.setInterval(() => {
      const hashes = pendingLeaseHashesRef.current;
      if (hashes.length === 0) return;
      void renewFn(hashes).catch(() => {
        // Fehler stillschweigend schlucken
      });
    }, 30 * 60 * 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [api]);

  const updatePlayer = (patch: Partial<ChannelStateDraft["player"]>) => {
    setDraft((current) => ({ ...current, player: { ...current.player, ...patch } }));
    setMessage("");
  };

  const save = async (replace = false) => {
    if (!dirty || locked) return;
    if (remoteConflict !== null && !replace) {
      setError("Der OBS-Stand wurde inzwischen geändert. Bitte eine Konfliktaktion wählen.");
      return;
    }
    setSaving(true);
    setError("");
    setMessage("");
    const requestDraft = structuredClone(draft);
    try {
      const response = await api.save({
        baseRevision: draftBaseRevision,
        ...(replace && remoteConflict !== null ? { replaceRevision: remoteConflict.revision } : {}),
        state: requestDraft,
      });
      setCommitted(response.state);
      setDraft(toDraft(response.state));
      setDraftBaseRevision(response.state.revision);
      setAudit((current) => [response.auditEntry, ...current].slice(0, 50));
      setUndoTargets(response.undoTargets);
      setRemoteConflict(null);
      setMessage(`Revision ${String(response.state.revision)} ist jetzt in OBS.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Speichern fehlgeschlagen.");
    } finally {
      setSaving(false);
    }
  };

  const toggleVisibility = async () => {
    if (visibilityBusy || !online) return;
    setVisibilityBusy(true);
    setError("");
    try {
      const response = await api.setVisibility(!committed.overlayEnabled);
      setCommitted(response.state);
      setDraftBaseRevision((current) => remoteConflict === null ? response.state.revision : current);
      setRemoteConflict((current) => current === null ? null : response.state);
      if (response.auditEntry !== null) {
        const auditEntry = response.auditEntry;
        setAudit((current) => [auditEntry, ...current].slice(0, 50));
      }
      setUndoTargets(response.undoTargets);
      setMessage(response.state.overlayEnabled ? "Overlay ist sichtbar." : "Overlay ist vollständig ausgeblendet.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Overlay-Schalter fehlgeschlagen.");
    } finally {
      setVisibilityBusy(false);
    }
  };

  const commitEffect = (effect: ActiveEffect, featured: boolean) => {
    setDraft((current) => {
      const exists = current.effects.some((item) => item.id === effect.id);
      const effects = (exists
        ? current.effects.map((item) => (item.id === effect.id ? effect : item))
        : [...current.effects, effect]
      ).map((item, order) => ({ ...item, order }));
      return {
        ...current,
        effects,
        featuredEffectId: featured
          ? effect.id
          : current.featuredEffectId === effect.id
            ? null
            : current.featuredEffectId,
      };
    });
    setEffectEditor(null);
  };

  const removeEffect = (id: string) => {
    setDraft((current) => ({
      ...current,
      effects: current.effects.filter((effect) => effect.id !== id).map((effect, order) => ({ ...effect, order })),
      featuredEffectId: current.featuredEffectId === id ? null : current.featuredEffectId,
    }));
  };

  const addManualGuest = () => {
    const name = manualGuestName.trim();
    if (name === "" || draft.group.length >= 5) return;
    const member: GroupMember = {
      id: crypto.randomUUID(),
      source: "manual",
      twitchUserId: null,
      name,
      portrait: { kind: "initials", text: name.slice(0, 2).toUpperCase() },
      hpPercent: 100,
    };
    setDraft((current) => ({ ...current, group: [...current.group, member] }));
    setManualGuestName("");
  };

  const addTwitchGuest = async () => {
    if (api.lookupTwitchUser === undefined || twitchLogin.trim() === "" || draft.group.length >= 5) return;
    setGuestBusy(true);
    setError("");
    try {
      const user = await api.lookupTwitchUser(twitchLogin.trim());
      const member = {
        id: crypto.randomUUID(),
        source: "twitch" as const,
        twitchUserId: user.id as GroupMember["twitchUserId"],
        name: user.displayName,
        portrait: {
          kind: "twitch" as const,
          userId: user.id as Exclude<PortraitRef, { kind: "initials" | "uploaded" | "bundled" }>["userId"],
          url: user.profileImageUrl,
        },
        hpPercent: 100,
      };
      setDraft((current) => ({ ...current, group: [...current.group, member] }));
      setTwitchLogin("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Twitch-Gast nicht gefunden.");
    } finally {
      setGuestBusy(false);
    }
  };

  const mutateToken = async (rotate: boolean) => {
    if (api.mutateOverlayToken === undefined) return;
    if (rotate && !window.confirm("Alte OBS-URL sofort ungültig machen und neuen Token erzeugen?")) return;
    const candidateToken = randomBase64UrlToken();
    const requestId = crypto.randomUUID();
    const pending = { candidateToken, requestId, expectedGeneration: overlayToken.generation };
    sessionStorage.setItem("irl-stream-hud-pending-token", JSON.stringify(pending));
    try {
      const result = await api.mutateOverlayToken(rotate, pending);
      const url = `${window.location.origin}/overlay#token=${candidateToken}`;
      sessionStorage.setItem("irl-stream-hud-obs-url", url);
      sessionStorage.removeItem("irl-stream-hud-pending-token");
      setObsUrl(url);
      setOverlayToken((current) => ({
        ...current,
        exists: true,
        generation: result.generation,
        createdAt: result.createdAt,
        lastUsedAt: null,
        connectedSockets: 0,
      }));
      setMessage(rotate ? "Neuer OBS-Link ist bereit; der alte wurde gesperrt." : "OBS-Link wurde erzeugt.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Token-Erzeugung fehlgeschlagen.");
    }
  };

  const undo = async (targetRevision: number) => {
    if (api.undo === undefined || !window.confirm(`Revision ${String(targetRevision)} wiederherstellen?`)) return;
    setSaving(true);
    try {
      const response = await api.undo(committed.revision, targetRevision);
      setCommitted(response.state);
      setDraft(toDraft(response.state));
      setDraftBaseRevision(response.state.revision);
      setRemoteConflict(null);
      setAudit((current) => [response.auditEntry, ...current].slice(0, 50));
      setUndoTargets(response.undoTargets);
      setMessage(`Revision ${String(targetRevision)} wurde als neue Revision wiederhergestellt.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Undo fehlgeschlagen.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-app">
      <header className="admin-topbar">
        <div className="brand-block">
          <span className="brand-mark"><Activity size={19} /></span>
          <div><strong>{initialBootstrap.capsule.name}</strong><span>Live-Regie</span></div>
        </div>
        <div className="topbar-status">
          <span className={`connection-pill ${online ? "is-online" : "is-offline"}`}>
            <Wifi size={14} />{online ? "Verbunden" : "Offline"}
          </span>
          <span className="revision-pill">Rev. {committed.revision}</span>
        </div>
        <button
          aria-checked={committed.overlayEnabled}
          aria-label="Overlay aktiv"
          className={`overlay-switch ${committed.overlayEnabled ? "is-on" : "is-off"}`}
          disabled={visibilityBusy || !online}
          onClick={() => void toggleVisibility()}
          role="switch"
          type="button"
        >
          {committed.overlayEnabled ? <Eye size={17} /> : <EyeOff size={17} />}
          <span>{committed.overlayEnabled ? "Overlay aktiv" : "Overlay aus"}</span>
          <i aria-hidden="true" />
        </button>
        <div className="editor-identity"><span>{initialBootstrap.editor.displayName}</span><small>Editor</small></div>
        {api.logout !== undefined && (
          <button
            aria-label="Abmelden"
            className="icon-button logout-button"
            onClick={() => {
              void api.logout?.().then(() => window.location.assign("/login"));
            }}
            title="Abmelden"
            type="button"
          >
            <LogOut size={16} />
          </button>
        )}
      </header>

      {!online && <div className="offline-banner">Offline – Bearbeitung pausiert; OBS wurde nicht geändert.</div>}

      <aside className="audit-rail">
        <div className="rail-heading"><Clock3 size={15} /><span>Änderungen</span></div>
        <div className="audit-list">
          {audit.length === 0 ? (
            <p className="empty-copy">Noch keine veröffentlichten Änderungen.</p>
          ) : audit.map((entry) => (
            <article className="audit-entry" key={entry.id}>
              <span className="audit-dot" />
              <div><strong>{entry.actor.displayName}</strong><p>{entry.summary}</p><time>{new Date(entry.createdAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</time></div>
            </article>
          ))}
        </div>
        {initialBootstrap.capabilities.undo && undoTargets.length > 0 && (
          <details className="undo-disclosure">
            <summary><Undo2 size={14} /> Rückgängig</summary>
            {undoTargets.slice(0, 6).map((target) => (
              <button key={target.revision} onClick={() => void undo(target.revision)} type="button">
                Rev. {target.revision}<span>{target.summary}</span>
              </button>
            ))}
          </details>
        )}
      </aside>

      <main className="admin-main">
        <section className="preview-panel">
          <div className="panel-heading">
            <div><span className="eyebrow">OBS-Komposition</span><h1>Live-Vorschau</h1></div>
            <span className="preview-scale">1920 × 1080 Referenz</span>
          </div>
          <div className="preview-canvas">
            <div className="preview-safe-area" />
            <div className="preview-hud-wrap">
              <TickingPreview
                forceVisible
                mediaUrls={previewMediaUrls}
                state={preview}
                previewOverlay={!committed.overlayEnabled ? <div className="disabled-veil">Overlay deaktiviert</div> : undefined}
              />
            </div>
          </div>
          <div className="preview-foot">
            <span><i className="anchor-dot" />Oben links verankert</span>
            <span>{draft.themeId === "classic-remix" ? "Classic Remix" : draft.themeId === "modern-compact" ? "Modern Compact" : "Modern Minimal"}</span>
          </div>
        </section>
      </main>

      <aside className="editor-rail" aria-busy={saving}>
        <div className="editor-rail-heading">
          <div><span className="eyebrow">Moderator-Konsole</span><h2>Live-Steuerung</h2></div>
          <Radio size={19} />
        </div>
        <div className="editor-scroll">
          <Section icon={<Activity size={16} />} title={draft.player.name}>
            <RangeField
              disabled={locked}
              label="Gesundheit"
              value={draft.player.hpPercent}
              onChange={(hpPercent) => updatePlayer({ hpPercent })}
            />
            <RangeField
              disabled={locked}
              label={draft.player.resource.name}
              value={draft.player.resource.percent}
              onChange={(percent) => updatePlayer({ resource: { ...draft.player.resource, percent } })}
            />
          </Section>

          <Section icon={<Sparkles size={16} />} title="Buffs & Debuffs">
            <div className="active-effects">
              {draft.effects.length === 0 && <p className="empty-copy">Keine aktiven Effekte.</p>}
              {draft.effects.map((effect) => (
                <div className={`active-effect active-effect--${effect.kind}`} key={effect.id}>
                  <button onClick={() => setEffectEditor(effect)} type="button">
                    <img alt="" src={`/assets/effects/${effect.iconId}.webp`} />
                    <span><strong>{effect.name}</strong><small>{effect.expiresAt === null ? "Ohne Ablauf" : new Date(effect.expiresAt).toLocaleString("de-DE", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}</small></span>
                  </button>
                  <button aria-label={`${effect.name} entfernen`} className="icon-button" disabled={locked} onClick={() => removeEffect(effect.id)} type="button"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <button className="button button--quiet button--full" disabled={locked || draft.effects.length >= 8} onClick={() => setEffectEditor("new")} type="button">
              <Plus size={15} /> Effekt hinzufügen <span>{draft.effects.length}/8</span>
            </button>
          </Section>

          {initialBootstrap.capabilities.petEditor && (
            <div className="desktop-only">
            <Section icon={<PawPrint size={16} />} title="Pet">
              {draft.pet === null ? (
                <button className="button button--quiet button--full" disabled={locked} onClick={() => setDraft((current) => ({ ...current, pet: { name: "Begleiter", subtitle: null, portrait: { kind: "initials", text: "BE" }, hpPercent: 100 } }))} type="button">
                  <Plus size={15} /> Pet einrichten
                </button>
              ) : (
                <>
                  <RangeField disabled={locked} label={`${draft.pet.name} Gesundheit`} value={draft.pet.hpPercent} onChange={(hpPercent) => setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, hpPercent } }))} />
                  <div className="field-grid">
                    <label><span>Name</span><input disabled={locked} maxLength={32} value={draft.pet.name} onChange={(event) => setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, name: event.target.value } }))} /></label>
                    <label><span>Unterzeile</span><input disabled={locked} maxLength={40} value={draft.pet.subtitle ?? ""} onChange={(event) => setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, subtitle: event.target.value === "" ? null : event.target.value } }))} /></label>
                  </div>
                  <PortraitInput disabled={locked} upload={uploadPortrait} onPortrait={(portrait) => setDraft((current) => ({ ...current, pet: current.pet === null ? null : { ...current.pet, portrait } }))} />
                  <button className="text-button text-button--danger" disabled={locked} onClick={() => setDraft((current) => ({ ...current, pet: null }))} type="button">Pet ausblenden</button>
                </>
              )}
            </Section>
            </div>
          )}

          {initialBootstrap.capabilities.groupEditor && (
            <div className="desktop-only">
            <Section icon={<Users size={16} />} title="Gruppe">
              {draft.group.length === 0 && <p className="empty-copy">Keine Gäste im Stream.</p>}
              {draft.group.map((member, index) => (
                <div className="guest-control" key={member.id}>
                  <div className="guest-heading"><span>{member.source === "twitch" && <MessageSquare size={13} />}{member.name}</span><button aria-label={`${member.name} entfernen`} className="icon-button" onClick={() => setDraft((current) => ({ ...current, group: current.group.filter((item) => item.id !== member.id) }))} type="button"><Trash2 size={14} /></button></div>
                  <RangeField disabled={locked} label={`${member.name} Gesundheit`} value={member.hpPercent} onChange={(hpPercent) => setDraft((current) => ({ ...current, group: current.group.map((item, itemIndex) => itemIndex === index ? { ...item, hpPercent } : item) }))} />
                </div>
              ))}
              {draft.group.length < 5 && (
                <div className="guest-adders">
                  <div className="inline-add"><input aria-label="Name des manuellen Gasts" disabled={locked} maxLength={32} placeholder="Gastname" value={manualGuestName} onChange={(event) => setManualGuestName(event.target.value)} /><button className="button button--quiet" disabled={locked} onClick={addManualGuest} type="button">Manuell</button></div>
                  <div className="inline-add"><input aria-label="Twitch-Login des Gasts" disabled={locked || guestBusy} placeholder="twitch_login" value={twitchLogin} onChange={(event) => setTwitchLogin(event.target.value)} /><button className="button button--twitch" disabled={locked || guestBusy} onClick={() => void addTwitchGuest()} type="button"><MessageSquare size={14} /> Twitch</button></div>
                </div>
              )}
            </Section>
            </div>
          )}

          <div className="desktop-only">
          <Section defaultOpen={false} icon={<ChevronDown size={16} />} title="Einrichten">
            <div className="field-grid">
              <label><span>Name</span><input disabled={locked} maxLength={32} value={draft.player.name} onChange={(event) => updatePlayer({ name: event.target.value })} /></label>
              <label><span>Titel</span><input disabled={locked} maxLength={40} value={draft.player.title ?? ""} onChange={(event) => updatePlayer({ title: event.target.value === "" ? null : event.target.value })} /></label>
              <label><span>Level</span><input disabled={locked} max={999} min={1} type="number" value={draft.player.level} onChange={(event) => updatePlayer({ level: Number(event.target.value) })} /></label>
              <label><span>Ressource</span><input disabled={locked} maxLength={16} value={draft.player.resource.name} onChange={(event) => updatePlayer({ resource: { ...draft.player.resource, name: event.target.value } })} /></label>
              <label><span>Ressourcenfarbe</span><input disabled={locked} type="color" value={draft.player.resource.color} onChange={(event) => updatePlayer({ resource: { ...draft.player.resource, color: event.target.value.toUpperCase() } })} /></label>
            </div>
                  <PortraitInput disabled={locked} upload={uploadPortrait} onPortrait={(portrait) => updatePlayer({ portrait })} />
            <div className="theme-picker" aria-label="Theme">
              {initialBootstrap.capabilities.enabledThemes.map((theme) => (
                <button className={draft.themeId === theme ? "theme-card is-selected" : "theme-card"} disabled={locked} key={theme} onClick={() => setDraft((current) => ({ ...current, themeId: theme }))} type="button">
                  <span className={`theme-swatch theme-swatch--${theme}`} /><strong>{theme === "classic-remix" ? "Classic Remix" : theme === "modern-compact" ? "Modern Compact" : "Modern Minimal"}</strong>
                </button>
              ))}
            </div>
            <div className="placement-grid">
              <label><span>X</span><input disabled={locked} max={384} min={0} type="number" value={draft.placement.x} onChange={(event) => setDraft((current) => ({ ...current, placement: { ...current.placement, x: Number(event.target.value) } }))} /></label>
              <label><span>Y</span><input disabled={locked} max={216} min={0} type="number" value={draft.placement.y} onChange={(event) => setDraft((current) => ({ ...current, placement: { ...current.placement, y: Number(event.target.value) } }))} /></label>
              <label><span>Skalierung</span><select disabled={locked} value={draft.placement.scale} onChange={(event) => setDraft((current) => ({ ...current, placement: { ...current.placement, scale: Number(event.target.value) } }))}><option value="0.75">75%</option><option value="0.9">90%</option><option value="1">100%</option><option value="1.1">110%</option><option value="1.25">125%</option></select></label>
            </div>
          </Section>
          </div>

          <div className="desktop-only">
          <Section defaultOpen={false} icon={<Radio size={16} />} title="OBS-Link">
            <div className="token-status"><span><i className={overlayToken.exists ? "is-ready" : ""} />{overlayToken.exists ? `Token Generation ${String(overlayToken.generation)}` : "Noch kein OBS-Link"}</span><small>{overlayToken.connectedSockets > 0 ? `${String(overlayToken.connectedSockets)} verbunden` : "Keine aktive OBS-Verbindung"}</small></div>
            {obsUrl !== "" && <button className="button button--quiet button--full" onClick={() => void navigator.clipboard.writeText(obsUrl)} type="button"><Copy size={15} /> OBS-Link kopieren</button>}
            <button className={overlayToken.exists ? "text-button text-button--danger" : "button button--primary button--full"} disabled={!online} onClick={() => void mutateToken(overlayToken.exists)} type="button">
              {overlayToken.exists ? <><RotateCw size={14} /> Neuen Token erzeugen</> : <><Plus size={15} /> OBS-Link erzeugen</>}
            </button>
          </Section>
          </div>
        </div>

        <footer className="save-dock">
          {remoteConflict !== null && (
            <div className="save-conflict" role="alert">
              <strong>OBS wurde inzwischen geändert</strong>
              <span>Rev. {draftBaseRevision} → {remoteConflict.revision}. Dein Entwurf ist noch lokal.</span>
              <div>
                <button
                  className="text-button"
                  onClick={() => {
                    setCommitted(remoteConflict);
                    setDraft(toDraft(remoteConflict));
                    setDraftBaseRevision(remoteConflict.revision);
                    setRemoteConflict(null);
                    setError("");
                  }}
                  type="button"
                >Serverstand laden</button>
                <button className="text-button text-button--danger" onClick={() => void save(true)} type="button">Meinen Entwurf veröffentlichen</button>
              </div>
            </div>
          )}
          <div className="publication-state" aria-live="polite">
            {error !== "" ? <span className="save-error">{error}</span> : message !== "" ? <span className="save-success">{message}</span> : dirty ? <span className="save-dirty">Noch nicht an OBS gesendet</span> : <span>Alles veröffentlicht</span>}
          </div>
          <button className="button button--save" disabled={!dirty || locked} onClick={() => void save()} type="button" aria-label="Änderungen speichern">
            {saving ? <RotateCw className="spin" size={17} /> : <Save size={17} />}{saving ? "Wird gespeichert …" : "Änderungen speichern"}
          </button>
        </footer>
      </aside>

      {effectEditor !== null && (
        <EffectFlyover
          effect={effectEditor === "new" ? undefined : effectEditor}
          initialFeatured={effectEditor !== "new" && effectEditor.id === draft.featuredEffectId}
          timezone={initialBootstrap.capsule.timezone}
          onClose={() => setEffectEditor(null)}
          onCommit={commitEffect}
        />
      )}
    </div>
  );
};
