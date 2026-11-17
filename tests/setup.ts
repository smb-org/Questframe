import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// Wartezeit für findBy/waitFor: Mit Coverage auf den GitHub-Runnern brauchte
// „speichert eine im HUD-Tab gezogene Bingo-Karte über die globale
// Speicherleiste“ 1505 ms bis zum Knopf und kippte am Default von 1000 ms
// (PR #28, Run 44072276903); lokal mit Coverage braucht derselbe Test 812 ms.
// Die Bedingungen selbst bleiben unverändert, nur das Zeitfenster ist größer.
configure({ asyncUtilTimeout: 3_000 });
