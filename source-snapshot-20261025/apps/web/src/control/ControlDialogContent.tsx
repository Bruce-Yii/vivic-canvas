import { Dialog } from "radix-ui";
import "./reading.css";
import { motion, useReducedMotion } from "motion/react";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import "@/components/hark/hark.css";
import "./hark-control.css";
import { useContext, type ComponentProps, type ReactNode } from "react";
import { ControlOverlayContext } from "./ControlOverlayContext";
import { useDisplayPreferences } from "@/state/canvasStore";
import { Button } from "@/components/ui/button";
import { useResolvedTheme } from "@/stage/useResolvedTheme";

/** Control-only reading surfaces share Radix focus trapping and Motion. */
export function ControlDialogContent({ title, description, children, className = "", ...props }:
  Omit<ComponentProps<typeof Dialog.Content>, "title"> & { title: string; description: string; children: ReactNode }) {
  const systemReduced = useReducedMotion();
  const container = useContext(ControlOverlayContext);
  const preferences = useDisplayPreferences();
  const theme = useResolvedTheme();
  const reduced = systemReduced || preferences.reducedMotion;
  return <Dialog.Portal container={container ?? undefined}>
    <Dialog.Overlay className="vivic-dialog-overlay vivic-hark-dialog-overlay" />
    <Dialog.Content asChild {...props}>
      <motion.div className={`vivic-control-dialog vh-hark ${className}`} data-appearance={theme} data-reduced-motion={reduced || undefined}
        initial={{ opacity: reduced ? 1 : 0, filter: reduced ? "none" : "blur(4px)" }} animate={{ opacity: 1, filter: "none" }} transition={{ duration: reduced ? 0 : 0.2, ease: "easeOut" }}>
        <HarkSurface as="div" className="vivic-hark-dialog-surface">
        <header className="vivic-dialog-header">
          <div className="min-w-0">
            <Dialog.Title className="vivic-reading-title">{title}</Dialog.Title>
            <Dialog.Description className="vivic-reading-caption mt-2">{description}</Dialog.Description>
          </div>
          <Dialog.Close asChild><Button variant="ghost" size="icon" aria-label="关闭窗口"><HarkIcon name="close" size={18} aria-hidden /></Button></Dialog.Close>
        </header>
        {children}
        </HarkSurface>
      </motion.div>
    </Dialog.Content>
  </Dialog.Portal>;
}
