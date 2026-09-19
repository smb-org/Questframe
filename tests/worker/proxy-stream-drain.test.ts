import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { MAX_PROXY_BODY_BYTES } from "../../src/worker/index";

// Regressionstest für den Proxy in src/worker/index.ts: Das Durable Object
// antwortet bei Auth-, CSRF- und Rate-Limit-Fehlern absichtlich VOR dem
// Body-Parse (Reihenfolge Auth → CSRF → Body ist sicherheitsrelevant und
// bleibt so). Reichte der Proxy den originalen Body-Stream unverändert durch,
// bliebe er bei einer solchen Frühantwort unkonsumiert liegen - workerd wirft
// dann beim Abbau der Anfrage "Can't read from request stream after response
// has been sent." (Linux-workerd/CI) bzw. bricht mit "disconnected: read end
// of pipe was aborted" ab (macOS-workerd, gemessen: 2 Treffer ohne Fix, 0 mit
// Fix) - zwei Meldungen für dieselbe Fehlerklasse, beide verschwinden mit dem
// Fix.
//
// Der Pull-Zähler unten misst die Vorbedingung zusätzlich plattformunabhängig
// und lokal zuverlässig: ein Body-Stream, der erst nach vielen
// pull()-Aufrufen schließt, muss nach dem Proxy vollständig zu Ende gelesen
// worden sein - unabhängig davon, ob das Durable Object den Inhalt am Ende
// überhaupt braucht. Vor dem Fix reicht der Proxy `request.body` live durch;
// workerds interne Zustellung an das Durable Object füllt dabei nur ein paar
// Chunks eigenmächtig vor (beobachtet: 2-3 pull()-Aufrufe) und bleibt danach
// stehen, weil niemand mehr liest - der Stream bleibt offen, `pullCount`
// bleibt weit unter `REQUIRED_PULLS`. Nach dem Fix puffert der Proxy den
// Body vollständig via `readBoundedBody`, bevor er überhaupt an das Durable
// Object weitergereicht wird - das liest den Stream zwingend bis zum Ende
// (`pullCount >= REQUIRED_PULLS`).
const REQUIRED_PULLS = 20;

const trackedBody = (): { body: ReadableStream<Uint8Array>; pullCount: () => number } => {
  let pullCount = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pullCount += 1;
      if (pullCount >= REQUIRED_PULLS) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      } else {
        controller.enqueue(new TextEncoder().encode(" "));
      }
    },
  });
  return { body, pullCount: () => pullCount };
};

let cookie = "";

describe("Proxy drainiert den Body-Stream bei früh beantworteten Fehlern", () => {
  beforeAll(async () => {
    const login = await exports.default.fetch(
      new Request("http://localhost/auth/dev", { redirect: "manual" }),
    );
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  });

  it("fehlendes Session-Cookie (401 vor Body-Parse) liest den Body vollständig zu Ende", async () => {
    const tracked = trackedBody();
    const request = new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { origin: "http://localhost:5173", "content-type": "application/json" },
      body: tracked.body,
    });
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(401);
    expect(tracked.pullCount()).toBeGreaterThanOrEqual(REQUIRED_PULLS);
  });

  it("fehlendes CSRF-Token (403 vor Body-Parse) liest den Body vollständig zu Ende", async () => {
    const tracked = trackedBody();
    const request = new Request("http://localhost/api/state", {
      method: "PUT",
      headers: {
        cookie,
        "x-editor-tab": "test-tab-a",
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: tracked.body,
    });
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(403);
    expect(tracked.pullCount()).toBeGreaterThanOrEqual(REQUIRED_PULLS);
  });

  // Sessionrouten wie /api/state prüfen die Session erst im Durable Object -
  // ein Client ohne gültiges Cookie erreicht den Puffer-Schritt im Proxy also
  // trotzdem. Ohne Content-Length-Header (wie hier) greift der Vorabcheck in
  // proxyToChannel nicht; das darf trotzdem nicht zu unbegrenztem Puffern
  // führen. `readBoundedBody` muss den Lese-Loop deshalb selbst an der
  // Schranke abbrechen (413), statt endlos weiterzulesen.
  it("Body ohne Content-Length, der nie schließt, bricht an der Schranke ab (413) statt endlos zu wachsen", async () => {
    const CHUNK_BYTES = 8_192;
    let pullCount = 0;
    const neverClosingBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCount += 1;
        // Schließt absichtlich nie - simuliert einen Client, der endlos sendet.
        controller.enqueue(new Uint8Array(CHUNK_BYTES).fill(0x20));
      },
    });
    const request = new Request("http://localhost/api/state", {
      method: "PUT",
      headers: { origin: "http://localhost:5173", "content-type": "application/json" },
      body: neverClosingBody,
    });
    const response = await exports.default.fetch(request);
    expect(response.status).toBe(413);
    // Größenordnung Schranke/Chunkgröße statt Explosion: der Loop darf nur so
    // oft pullen, wie nötig ist, um die Schranke zu überschreiten (+1 Chunk),
    // nicht beliebig oft. Mit `request.arrayBuffer()` statt Lese-Loop würde
    // dieser Test hängen/timeouten, weil der Stream nie schließt - siehe
    // Gegenprobe im Bericht.
    expect(pullCount).toBeGreaterThan(1);
    expect(pullCount).toBeLessThanOrEqual(Math.ceil(MAX_PROXY_BODY_BYTES / CHUNK_BYTES) + 1);
  }, 5_000);
});
