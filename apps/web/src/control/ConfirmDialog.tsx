import { AlertDialog } from "radix-ui";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HarkSurface } from "@/components/hark/HarkPrimitives";

interface ConfirmDialogProps {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  disabled?: boolean;
  onConfirm: () => void;
}

/** Destructive-action guard (clear canvas / delete canvas). */
export const ConfirmDialog = ({
  trigger,
  title,
  description,
  confirmLabel = "确认",
  disabled,
  onConfirm,
}: ConfirmDialogProps) => {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | undefined>();
  const [appearance, setAppearance] = useState<"light" | "dark">("light");
  return <AlertDialog.Root onOpenChange={open => {
    if (!open) { setPortalContainer(undefined); return; }
    // Fixed dialogs must escape animated page containers. Keep them inside a
    // native dialog when one exists so they remain in the browser top layer.
    setPortalContainer(triggerRef.current?.closest<HTMLDialogElement>("dialog[open]") ?? undefined);
    const root = triggerRef.current?.closest("[data-appearance],[data-mobile-theme]");
    setAppearance((root?.getAttribute("data-appearance") ?? root?.getAttribute("data-mobile-theme")) === "dark" ? "dark" : "light");
  }}>
    <AlertDialog.Trigger ref={triggerRef} asChild disabled={disabled}>
      {trigger}
    </AlertDialog.Trigger>
    <AlertDialog.Portal container={portalContainer}>
      <AlertDialog.Overlay className="hark-dialog-overlay fixed inset-0 z-[100]" />
      <AlertDialog.Content asChild><HarkSurface as="section" data-appearance={appearance} className="vh-hark hark-confirm fixed left-1/2 top-1/2 z-[101] w-[min(92vw,380px)] -translate-x-1/2 -translate-y-1/2 p-6">
        <AlertDialog.Title className="hark-confirm-title">
          {title}
        </AlertDialog.Title>
        <AlertDialog.Description className="hark-confirm-description mt-2">
          {description}
        </AlertDialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel asChild>
            <Button variant="secondary" size="sm">
              取消
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action asChild>
            <Button variant="destructive" size="sm" onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </AlertDialog.Action>
        </div>
      </HarkSurface></AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
};
