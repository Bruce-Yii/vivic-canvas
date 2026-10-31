# Space Switch Loading Design

## Intent

When a user opens a Space from the Space menu, make the destination display window feel like it is actively loading instead of appearing instantly or blank while it synchronizes.

## Goals and boundaries

- Show a centered spinner and short loading label over the display until the requested canvas is hydrated.
- Keep the loader visible for at least 1.1 seconds, then fade it out after hydration.
- Once the requested canvas has hydrated, keep startup loading dismissed across later resets or runtime re-pins.
- Keep the existing menu behavior and canvas sync protocol unchanged.
- This covers the display window opened by a Space selection; it does not add a loader to the menu item or redesign other loading screens.

## Approaches

- **Loader in the display window (selected):** Covers the actual canvas startup and synchronization. Wait for the requested canvas, with a 1.1 second minimum display time.
- **Spinner in the menu item:** The menu closes as soon as the display opens, so the spinner would disappear before the canvas finishes loading.
- **Both places:** Adds duplicate feedback while the menu spinner still cannot cover display startup.

## Constraints and implementation choices

The Space menu opens `/display?canvasId=…` in a new window. Use the display runtime's hydrated status and canvas ID to know when the requested canvas is ready, then latch successful startup so a later authorized reset/re-pin does not strand the loader against the old URL ID. Keep the loading layer accessible with a status label; respect reduced-motion preferences for the exit transition and spinner motion. If the owner has not supplied a snapshot yet, the existing display retry behavior remains responsible for resynchronization.

## Success criteria

The display shows a visible spinner during startup, never disappears before the requested canvas is hydrated, and remains visible for at least 1.1 seconds when hydration is faster. It then fades away to reveal the display.
