import type { CeremonySound } from "./ceremonies";

const SOUND_SOURCES: Record<Exclude<CeremonySound, null>, string> = {
  complete: "/assets/sounds/complete.mp3",
  tick: "/assets/sounds/tick.mp3",
};

const MINIMUM_GAP_MS: Record<Exclude<CeremonySound, null>, number> = {
  complete: 320,
  tick: 140,
};

type AudioFactory = (source: string) => HTMLAudioElement;

export type CeremonyAudioPolicy = {
  preload: () => void;
  play: (sound: CeremonySound) => void;
  stop: () => void;
};

export const createCeremonyAudioPolicy = (
  options: { createAudio?: AudioFactory; now?: () => number } = {},
): CeremonyAudioPolicy => {
  const createAudio = options.createAudio ?? ((source: string) => new Audio(source));
  const now = options.now ?? Date.now;
  const audio = new Map<Exclude<CeremonySound, null>, HTMLAudioElement>();
  const lastPlayedAt = new Map<Exclude<CeremonySound, null>, number>();

  const preload = () => {
    for (const sound of Object.keys(SOUND_SOURCES) as Array<Exclude<CeremonySound, null>>) {
      if (audio.has(sound)) continue;
      try {
        const element = createAudio(SOUND_SOURCES[sound]);
        element.preload = "auto";
        element.load();
        audio.set(sound, element);
      } catch {
        // Fehlende Audio-Unterstützung darf die visuelle Zeremonie nicht brechen.
      }
    }
  };

  const play = (sound: CeremonySound) => {
    if (sound === null) return;
    const element = audio.get(sound);
    if (element === undefined) return;
    const current = now();
    const previous = lastPlayedAt.get(sound);
    if (previous !== undefined && current - previous < MINIMUM_GAP_MS[sound]) return;
    lastPlayedAt.set(sound, current);
    try {
      element.currentTime = 0;
      void element.play().catch(() => undefined);
    } catch {
      // Autoplay-Verbote und defekte Audio-Geräte sind nur eine Zugabe zur Zeremonie.
    }
  };

  const stop = () => {
    for (const element of audio.values()) {
      try {
        element.pause();
        element.currentTime = 0;
      } catch {
        // Das Beenden des Tons darf den Stream nicht beeinflussen.
      }
    }
  };

  return { preload, play, stop };
};
