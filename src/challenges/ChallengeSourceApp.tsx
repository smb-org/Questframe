import { useEffect, useRef, useState } from "react";

import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import { ChallengeLog } from "../modules/win-challenges/ui/ChallengeLog";
import "./challenge-source.css";
import {
  accountForChallengeUpdate,
  parseChallengeMessage,
  tokenFromLocation,
} from "./wire";

const RETRY_BASE_MS = 750;

import type { ChallengeUpdate } from "../shared/contracts/win-challenges";

export const ChallengeSourceApp = () => {
  const [update, setUpdate] = useState<ChallengeUpdate | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastSeenRef = useRef(-1);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const token = tokenFromLocation();
    if (token === null) return;

    let disposed = false;
    let revoked = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;
    let retry = 0;

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/challenge`, [
        OVERLAY_SOCKET_PROTOCOL,
        token,
      ]);
      socket.addEventListener("open", () => {
        retry = 0;
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        let input: unknown;
        try {
          input = JSON.parse(message.data) as unknown;
        } catch {
          setUpdate(null);
          return;
        }
        const parsed = parseChallengeMessage(input);
        if (parsed === null) {
          // Ein Parse-Fehler darf das HUD vor Zuschauern niemals neu laden.
          setUpdate(null);
          return;
        }
        if (!("eventSeq" in parsed)) {
          revoked = true;
          setUpdate(null);
          socket?.close();
          return;
        }
        const ceremony = accountForChallengeUpdate(parsed, lastSeenRef.current);
        lastSeenRef.current = ceremony.lastSeen;
        // Schritt 13 hängt die Zeremonie an `ceremony.shouldFire` ein. Die
        // lastSeen-Buchführung läuft schon jetzt, damit dort nur noch der
        // Effekt fehlt und nicht die Regel, wann er feuern darf.
        setUpdate(parsed);
      });
      socket.addEventListener("close", () => {
        if (disposed || revoked) return;
        setUpdate(null);
        const delay = Math.min(30_000, RETRY_BASE_MS * 2 ** retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay + Math.floor(Math.random() * 400));
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  return update === null ? null : <ChallengeLog now={now} update={update} />;
};
