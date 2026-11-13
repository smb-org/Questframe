# TODOS

Zurückgestellte Arbeit mit genug Kontext, dass sie in drei Monaten noch verständlich ist.

---

## Teil-Code für Challenge-Sets

**Was:** Ein Set veröffentlichen erzeugt einen kurzen Code (etwa `QF-7K3R`).
Wer ihn in seiner Admin-Konsole eintippt, lädt das Set direkt, ohne Datei.

**Warum:** Ein Code ist im Stream vorlesbar. Genau dort entsteht Verbreitung —
ein Dateianhang im Chat wird nicht weitergereicht, ein vorgelesener Code schon.

**Pros:** Das Dateiformat aus Runde 1 trägt den Code-Weg bereits vollständig;
es bliebe reine Zustellung. Fühlt sich nach Produkt an statt nach Bastelei,
und das war einer der vier Punkte, die Verbreitung tatsächlich bremsen.

**Cons:** Wir würden fremden Nutzertext hosten, der ungefiltert in die
OBS-Quellen anderer Leute rendert. Das bringt Moderation, Missbrauchsfälle,
Speicherkosten und eine Haftungsfrage mit — alles Dinge, die eine lesbare
Datei nicht hat, weil der Empfänger sie vor dem Import selbst öffnen kann.

**Kontext:** Entschieden am 2026-09-14 in der Entwurfssitzung zu
`docs/designs/challenge-sets.md` gegen den Code und für die Datei. Der Grund
war ausdrücklich Vertrauen, nicht Aufwand: bei der Datei hängt das Vertrauen
nicht am Betreiber. Wer diesen Punkt später aufgreift, sollte zuerst
beantworten, wer den Inhalt moderiert und was bei Missbrauch passiert — nicht,
wie der Code technisch zugestellt wird. Das ist der leichte Teil.

**Hängt ab von:** Runde 1 (Format und Codec müssen stehen) und davon, dass
Sets sich im Alltag überhaupt bewähren.

---

## Erste echte Bingo-Karte aus dem Chat

**Was:** Im nächsten Stream den Chat nach Bingo-Feldern fragen und die 16
besten als erste echte Karte festhalten. Die exportierte Datei dient danach
als Codec-Fixture für die Import-Tests.

**Warum:** Die vier Startvorlagen stammen aus einer Ideenliste, nicht aus dem
Chat. Eine Karte, die der Chat selbst geschrieben hat, ist der eigentliche
Test, ob das Format im Stream trägt.

**Kontext:** Planpunkt aus `docs/designs/bingo-board.md`, beim Ship des
Bingo-Branches als Folgeaufgabe festgelegt. Nach dem Deploy zusätzlich prüfen:
Export und Import in einen zweiten Staging-Kanal ergeben dieselbe Karte, und
bestehende HUD- und Composite-Quellen laufen mit dem neuen State-Feld weiter.

**Hängt ab von:** Merge und Deploy des Bingo-Moduls.
