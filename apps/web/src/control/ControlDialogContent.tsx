import { Dialog } from "radix-ui";
import "./reading.css";
import { useReducedMotion } from "motion/react";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";
import "@/components/hark/hark.css";
import "./hark-control.css";
import { useContext, type ComponentProps, type ReactNode } from "react";
import { ControlOverlayContext } from "./ControlOverlayContext";
import { useDisplayPreferences } from "@/state/canvasStore";
import { Button } from "@/components/ui/button";
import { useResolvedTheme } from "@/stage/useResolvedTheme";

/** Control-only reading surfaces share Radix focus trapping and Motion. */
export function ControlDialogContent({ title, description, children, className = "", overlayClassName = "", ...props }:
  Omit<ComponentProps<typeof Dialog.Content>, "title"> & { title: string; description: string; children: ReactNode; overlayClassName?: string }) {
  const systemReduced = useReducedMotion();
  const container = useContext(ControlOverlayContext);
  const preferences = useDisplayPreferences();
  const theme = useResolvedTheme();
  const reduced = systemReduced || preferences.reducedMotion;
  return <Dialog.Portal container={container ?? undefined}>
    <Dialog.Overlay className={`vivic-dialog-overlay vivic-hark-dialog-overlay ${overlayClassName}`} />
    <Dialog.Content asChild {...props}>
      <div className={`vivic-control-dialog vh-hark ${className}`} data-appearance={theme} data-reduced-motion={reduced || undefined}>
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
      </div>
    </Dialog.Content>
  </Dialog.Portal>;
}
