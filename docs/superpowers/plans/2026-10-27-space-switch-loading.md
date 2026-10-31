# Space Switch Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a visible loading layer in a Space display window until its requested canvas is hydrated, with a minimum display time of 1.1 seconds.

**Architecture:** `DisplayApp` will subscribe to the existing display runtime status and keep an accessible loading layer mounted until both the canvas is ready and the minimum time has elapsed. A small display stylesheet will provide the spinner and fade-out, respecting reduced-motion preferences.

**Tech Stack:** React 19, TypeScript, existing `useSyncExternalStore` display status bridge, CSS.

**Spec:** `docs/superpowers/specs/2026-10-27-space-switch-loading-design.md`

## Global Constraints

- Keep the existing Space menu behavior and canvas sync protocol unchanged.
- Show the loader until the requested canvas is hydrated.
- Keep it visible for at least 1.1 seconds when hydration is faster.
- Respect reduced-motion preferences for spinner motion and the exit transition.

## Review Focus

- **Pinned canvas mismatch:** A snapshot for another canvas must not dismiss the loader; compare the runtime canvas ID with the URL's `canvasId`.
- **Later re-pin after reset:** After first matching hydration, keep startup loading dismissed so the original URL pin cannot strand the overlay.
- **Slow or absent owner snapshot:** Keep the display runtime's existing retry behavior; avoid rendering the wrong pinned canvas as ready.
- **Fast hydration:** The loader must remain visible for the full 1.1 seconds.
- **Reduced motion:** Keep the status label and static spinner ring while disabling animated motion.
- **Fade-out interaction:** After readiness, the layer must stop blocking pointer input while it fades.

---

### Task 1: Add the display startup loading layer

**Files:**
- Modify: `apps/web/src/display/DisplayApp.tsx`
- Create: `apps/web/src/display/display.css`

**Interfaces:**
- Consume `getDisplayStatus()` and `subscribeDisplayStatus()` from `@/sync/browserRuntime`.
- Use the URL's existing `pinnedCanvasId` to determine whether the hydrated status belongs to the requested canvas; when no canvas is pinned, any hydrated canvas is acceptable.
- Add a status element with the Chinese label `正在切换空间…` and a decorative spinner. The layer fades out only after the requested canvas is hydrated and 1.1 seconds have elapsed since mount.

- [x] **Step 1: Implement the startup readiness and minimum-duration state in `DisplayApp.tsx`**

  Subscribe to a primitive readiness snapshot so React rerenders when hydration changes. Latch the first matching hydrated canvas, and start a 1,100 ms timer on mount. Once both the latched readiness and timer are complete, mark the layer as leaving; later runtime resets must not re-open startup loading. Disable pointer events immediately and let CSS complete the fade.

- [x] **Step 2: Add spinner and overlay styles in `display.css`**

  Center a compact spinner and label over the stage, animate the ring when motion is allowed, and fade the overlay out. Under reduced motion, leave a static ring and disable the transition.

- [x] **Step 3: Import the display stylesheet and review the final diff**

  Confirm only the display startup experience changed. Automated tests and builds are omitted for this request.
