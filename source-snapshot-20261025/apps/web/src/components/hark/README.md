# Vivic Hark components

Source: `ECdison6227/rea-ui-library@26ac2724`, `platforms/web/hark`. See `SOURCE.json` for retained asset SHA-256 and D adaptations, and the project update at `docs/updates/2026-10-23-hark-full-ui.md`.

`HarkPrimitives.tsx` provides source glyphs, continuous-corner surfaces, source-role task cards, tabs and frozen-sky backdrops. `HarkCanvasBackdrop.tsx` keeps synchronized Vivic tint preferences without a graphics context. `source-theme.css` retains original light/dark declarations; `hark.css` registers seven original font payloads and scopes the source roles to `.vh-hark`.

Surface layers support the original `--surface-fill`, `--surface-stroke`, `--surface-blur`, `--surface-radius` variables. Only decorative layers are clipped; editing tools and focus rings remain outside. Layout border-box measurements work under React Flow zoom.

Source glyph strings are build-time data, never remote HTML. Semantic aliases and whitespace normalization do not alter SVG path geometry. Font coverage excludes Chinese, so the existing platform fallback remains visible for CJK text. Frozen skies are offline target renders, not measurements of an original Hark runtime.

`task-catalog.json` retains existing Vivic template business content from the previous implementation. It does not import a former UI stylesheet or renderer. See `NOTICE.txt` for original asset rights.

2026-10-24 refinement: the repository HEAD was checked and is still `26ac2724f29b4ee46962146fed2b6d545bf62180`. `card-refinement.css` simplifies the title hierarchy and preserves genuine status/source labels. `space-light.css` is a **D Vivic adaptation**: it animates retained source sky frames and composited light with transform/opacity, without importing the original weather/geolocation/native bridge runtime. Source 800 ms material and 120 ms press timings remain; new travel paths, entry easing, intensity and task/focus glow are target choices. Pause, offscreen/document visibility, and a live OS reduced-motion preference suspend the decorations. `@/motion/spaceMotion` accepts ephemeral feedback only after the host confirms a successful operation.
