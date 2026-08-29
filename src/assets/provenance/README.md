# Visual asset provenance

The production HUD uses original generated artwork rather than assets extracted from a game. Source masters are retained next to this file; deterministic crops and WebP derivatives are built with `npm run assets:build`.

## MuAPI / Grok Imagine Quality

Generated on 2026-08-29 through the project's configured MuAPI connection with `grok-quality`. Each prompt explicitly excluded text, logos, watermarks, recognizable franchise symbols, and copied game UI.

| Master | MuAPI request | Selected output | Purpose |
| --- | --- | --- | --- |
| `muapi/buff-atlas-master.jpg` | `f78ad76b-15cd-4c97-8741-f44599eb1797` | `10c4b582720347d8a00e92a742d99cf4.jpg` | 5×4 atlas for the 20 standard buffs |
| `muapi/debuff-atlas-master.jpg` | `29f85977-299c-4886-8136-3d1206dd83a0` | `2c1977bee40045afb204028f92cc062e.jpg` | 5×4 atlas for the 20 standard debuffs |
| `muapi/classic-remix-master.jpg` | `b7fbd9ba-5554-49d9-9731-04a48e541b64` | `4757744c15a2423fba507587193e16b2.jpg` | Original forged-iron, brass, and map-contour panel surface |

The atlas prompts assigned one outdoor-state concept to each row-major cell. The frame prompt requested a dark, legible, front-facing material plate with restrained brass trim and forest-map contours.

## Rebuild and verification

```sh
npm run assets:build
npm run assets:verify
```

Verification checks the complete expected filename set, dimensions, format, alpha policy, and maximum file size.
