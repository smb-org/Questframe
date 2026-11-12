import { useEffect, useState } from "react";

import { OVERLAY_SOCKET_PROTOCOL } from "../shared/contracts/protocol";
import {
  hasWatchdogReloadMarker,
  markWatchdogReload,
  nextReconnectDelayMs,
  reloadWindow,
  SOCKET_PONG_MESSAGE,
  startSocketHeartbeat,
} from "../shared/reconnect";
import { BingoCeremonyStage } from "./BingoCeremonyStage";
import { parseBingoMessage } from "./wire";
import { tokenFromLocation, placementAtOriginFromLocation } from "../challenges/wire";
import type { BingoUpdateMessage } from "../modules/bingo/contracts/schemas";
import { loadBingoStyle, type BingoStyleLoader } from "./style-loader";
import { useBingoPresentation } from "./useBingoPresentation";

const PARSE_RELOAD_STORAGE_KEY = "bg-parse-reload-at";
const PARSE_RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

const reloadAfterWireParseFailure = (reload: () => void): void => {
  if (hasWatchdogReloadMarker(PARSE_RELOAD_STORAGE_KEY, PARSE_RELOAD_COOLDOWN_MS)) return;
  if (!markWatchdogReload(PARSE_RELOAD_STORAGE_KEY)) return;
  reload();
};

export const BingoSourceApp = ({
  loadStyle = loadBingoStyle,
  reloadPage = reloadWindow,
}: {
  loadStyle?: BingoStyleLoader;
  reloadPage?: () => void;
} = {}) => {
  const [update, setUpdate] = useState<BingoUpdateMessage | null>(null);
  const [placementAtOrigin] = useState(placementAtOriginFromLocation);
  const presentation = useBingoPresentation({ update, loadStyle });
  const { acceptUpdate, clearCeremony } = presentation;

  useEffect(() => {
    const token = tokenFromLocation();
    if (token === null) return;

    let disposed = false;
    let revoked = false;
    let socket: WebSocket | null = null;
    let stopHeartbeat: (() => void) | null = null;
    let retryTimer: number | null = null;
    let retry = 0;

    const connect = () => {
      if (disposed || revoked) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(`${protocol}//${window.location.host}/ws/bingo`, [OVERLAY_SOCKET_PROTOCOL, token]);
      socket.addEventListener("open", () => {
        stopHeartbeat?.();
        stopHeartbeat = startSocketHeartbeat(socket as WebSocket);
        retry = 0;
      });
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        if (event.data === SOCKET_PONG_MESSAGE) return;
        let input: unknown;
        try {
          input = JSON.parse(event.data) as unknown;
        } catch {
          setUpdate(null);
          clearCeremony();
          reloadAfterWireParseFailure(reloadPage);
          return;
        }
        const parsed = parseBingoMessage(input);
        if (parsed === null) {
          setUpdate(null);
          clearCeremony();
          reloadAfterWireParseFailure(reloadPage);
          return;
        }
        if (parsed.type === "token_revoked") {
          revoked = true;
          setUpdate(null);
          clearCeremony();
          socket?.close();
          return;
        }
        acceptUpdate(parsed);
        setUpdate(parsed);
      });
      socket.addEventListener("close", () => {
        stopHeartbeat?.();
        stopHeartbeat = null;
        clearCeremony();
        if (disposed || revoked) return;
        setUpdate(null);
        const delay = nextReconnectDelayMs(retry);
        retry += 1;
        retryTimer = window.setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      stopHeartbeat?.();
      stopHeartbeat = null;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [acceptUpdate, clearCeremony, reloadPage]);

  if (!presentation.ready || update === null) return null;
  return <BingoCeremonyStage board={update.board} placementAtOrigin={placementAtOrigin} presentation={presentation} />;
};
