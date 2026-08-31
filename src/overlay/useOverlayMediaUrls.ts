import { useEffect, useRef, useState } from "react";

import type { ChannelState } from "../shared/contracts/state";

const uploadedHashes = (state: ChannelState): string[] => {
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

export const useOverlayMediaUrls = (
  state: ChannelState | null,
  token: string | null,
): ReadonlyMap<string, string> => {
  const [mediaUrls, setMediaUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const objectUrlsRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (token === null || state === null) return;
    const needed = new Set(uploadedHashes(state));
    let disposed = false;
    let changed = false;
    for (const [hash, url] of objectUrlsRef.current) {
      if (!needed.has(hash)) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(hash);
        changed = true;
      }
    }
    const missing = [...needed].filter((hash) => !objectUrlsRef.current.has(hash));
    void Promise.all(
      missing.map(async (hash) => {
        let response: Response;
        try {
          response = await fetch(`/api/media/${hash}`, {
            headers: { authorization: `Bearer ${token}` },
          });
        } catch {
          // Netzwerkfehler: Portrait fehlt bis zum naechsten State-Update, die
          // uebrigen geladenen URLs werden trotzdem veroeffentlicht.
          return;
        }
        if (!response.ok) return;
        const url = URL.createObjectURL(await response.blob());
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrlsRef.current.set(hash, url);
        changed = true;
      }),
    ).then(() => {
      // Nur bei tatsaechlicher Aenderung neu publizieren, sonst unnoetiger Render.
      if (changed && !disposed) setMediaUrls(new Map(objectUrlsRef.current));
    });
    return () => {
      disposed = true;
    };
  }, [state, token]);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current.values()) URL.revokeObjectURL(url);
      objectUrlsRef.current.clear();
    },
    [],
  );

  return mediaUrls;
};
