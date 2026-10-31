import { useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { HarkIcon, HarkSurface } from "@/components/hark/HarkPrimitives";

/** Hark attachment-menu pattern; keep draft/upload owners mounted while closed. */
export function ComposerMenu({ children }: { children(close: () => void): ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className="vivic-composer-icon" aria-label="添加内容" title="添加内容" data-vivic-add>
      <HarkIcon name="add" size={18} />
    </button></Popover.Trigger>
    <Popover.Content forceMount hidden={!open} asChild side="top" align="end" sideOffset={12}
      onFocusOutside={event => event.preventDefault()}
      onPointerDownOutside={event => { if ((event.target as Element | null)?.closest?.('[role="dialog"],dialog')) event.preventDefault(); }}
      onEscapeKeyDown={event => { event.preventDefault(); close(); }}>
      <HarkSurface as="div" className="vivic-composer-menu" aria-label="添加内容">
        {children(close)}
      </HarkSurface>
    </Popover.Content>
  </Popover.Root>;
}
