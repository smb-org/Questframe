// Bewusst ohne Abhaengigkeiten. Diese Konstante wird auch vom Overlay-Bundle
// gebraucht, und ein Import aus contracts/api.ts wuerde zod samt aller Schemata
// in die OBS-Browserquelle ziehen. Deshalb steht sie hier allein.
export const OVERLAY_SOCKET_PROTOCOL = "irl-stream-hud.overlay";
export const DOCK_SOCKET_PROTOCOL = "irl-stream-hud.dock";
