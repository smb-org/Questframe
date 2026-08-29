import { useEffect, useMemo, useRef, useState } from "react";

import type { ChannelState } from "../shared/contracts/state";
import {
  fingerprintOverlayToken,
  loadOverlaySnapshot,
  removeOverlaySnapshot,
  storeOverlaySnapshot,
} from "./cache";
import { HudRenderer } from "./HudRenderer";
import { parseOverlayMessage } from "./wire";

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

export const OverlayApp = () => {
  const [state, setState] = useState<ChannelState | null>(null);
  const [nowMilliseconds, setNowMilliseconds] = useState(() => Date.now());
  const [mediaUrls, setMediaUrls] = useState<ReadonlyMap<string, string>>(new Map());
  const objectUrlsRef = useRef(new Map<string, string>());
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const token = params.get("token");
  const capsuleScope = window.location.host;

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMilliseconds(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retry = 0;
    let fingerprint = "";
    let revoked = false;

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/overlay?token=${encodeURIComponent(token)}`,
      );
      socket.addEventListener("open", () => {
        retry = 0;
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let input: unknown;
        try {
          input = JSON.parse(event.data) as unknown;
        } catch {
          return;
        }
        const parsed = parseOverlayMessage(input);
        if (parsed === null) return;
        if (parsed.type === "snapshot" || parsed.type === "state_committed") {
          setState(parsed.state);
          if (fingerprint !== "") {
            storeOverlaySnapshot(capsuleScope, fingerprint, parsed.state);
          }
        } else {
          revoked = true;
          setState(null);
          if (fingerprint !== "") removeOverlaySnapshot(capsuleScope, fingerprint);
          socket?.close();
        }
      });
      socket.addEventListener("close", () => {
        if (disposed || revoked) return;
        const delay = Math.min(30_000, 750 * 2 ** retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 400));
      });
    };

    void fingerprintOverlayToken(token)
      .then((value) => {
        if (disposed) return;
        fingerprint = value;
        const cached = loadOverlaySnapshot(capsuleScope, fingerprint);
        if (cached !== null) setState(cached);
      })
      .catch(() => {
        // Fingerprinting or cache load failed, proceed anyway
      })
      .finally(() => {
        if (!disposed) connect();
      });

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [capsuleScope, token]);

  useEffect(() => {
    if (token === null || state === null) return;
    const needed = new Set(uploadedHashes(state));
    let disposed = false;
    for (const [hash, url] of objectUrlsRef.current) {
      if (!needed.has(hash)) {
        URL.revokeObjectURL(url);
        objectUrlsRef.current.delete(hash);
      }
    }
    const missing = [...needed].filter((hash) => !objectUrlsRef.current.has(hash));
    void Promise.all(
      missing.map(async (hash) => {
        const response = await fetch(`/api/media/${hash}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const url = URL.createObjectURL(await response.blob());
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrlsRef.current.set(hash, url);
      }),
    ).then(() => {
      if (!disposed) setMediaUrls(new Map(objectUrlsRef.current));
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

  return state === null ? null : (
    <HudRenderer state={state} nowMilliseconds={nowMilliseconds} mediaUrls={mediaUrls} />
  );
};
