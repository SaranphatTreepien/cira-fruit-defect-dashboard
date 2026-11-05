# Image prompts for the Live page "WOW" upgrade

Put generated files in `public/images/live/`. Prefer `.webp` (or `.png` for transparency).
The fruit path, baskets and numbers stay as HTML/SVG on top of the image, so the image must be a backdrop only: no text, no fruit, no UI.

## 1. Stage background (required) — `stage-bg.webp`, 1920x800 (about 2.4:1)

```
Wide cinematic 3/4 top-down view of a futuristic fruit sorting line inside a clean modern agri-tech factory at night.
A single glossy dark conveyor belt enters from the far left, runs straight to the center, then splits like a Y into two belts:
the upper-right branch glows soft emerald green, the lower-right branch glows warm amber orange.
At the left third, above the belt, a sleek AI vision camera gantry with a thin cyan scanning light curtain across the belt.
At the end of the upper branch, an empty premium crate lit green; at the end of the lower branch, an empty crate lit amber.
Belts are EMPTY — no fruit, no objects, no people, no text, no logos, no labels.
Dark teal-graphite environment, subtle volumetric light, faint holographic grid on the floor, soft bokeh in the background,
high contrast, sharp clean industrial design, Unreal Engine 5 render style, ultra detailed, 8k.
Composition: keep the center and right side uncluttered so UI cards can sit on top.
```

Negative prompt (if your tool has one):
```
fruit, oranges, apples, people, hands, text, letters, watermark, logo, UI, numbers, clutter, blurry belt, distorted perspective, fisheye
```

## 2. Camera scan glow (optional) — `scan-glow.png`, 512x512, transparent background

```
Isolated cyan holographic scanning light beam, vertical light curtain with fine scanlines and small particles,
glowing edges, on a fully transparent background, no objects, no text.
```

## 3. Crate icons (optional) — `crate-good.png` and `crate-defect.png`, 512x512, transparent background

```
Single empty premium modern fruit crate, 3/4 view, matte dark graphite with a glowing [emerald green | amber orange] neon rim light,
isolated on a fully transparent background, product render, soft shadow, no fruit, no text, no logo.
```

## 4. Fruit sprites (optional, real photos better than emoji) — `orange.png`, `apple.png`, 256x256, transparent

```
Single fresh [orange | red apple], top-down view, studio lighting, crisp detail, isolated on a fully transparent background, no shadow, no text.
```

## Tips
- Generate several, pick the one where the belt split is closest to: left 0–50% at mid height, then up-right to ~(82%, 24%) and down-right to ~(82%, 76%). The tokens follow those points; they can be retuned in CSS to match the image.
- If the image tool cannot do transparency, use a solid black background and the page can use `mix-blend-mode: screen` for the glow.
