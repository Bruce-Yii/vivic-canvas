import { useState, useSyncExternalStore } from "react";
import { Bell } from "lucide-react";
import { Popover } from "radix-ui";
import { HarkSurface } from "@/components/hark/HarkPrimitives";
import type { ControlHost } from "@/sync/controlHost";
import { RemindersSection } from "./RemindersSection";

export function ReminderCenter({ host, disabled, theme }: { host: ControlHost; disabled: boolean; theme: "light" | "dark" }) {
  const snapshot = useSyncExternalStore(host.subscribe, host.getSnapshot);
  const [open, setOpen] = useState(false);
  const active = snapshot.reminders.filter(item => !item.card.sourceData.notifiedAt).length;
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild>
      <button type="button" className="vivic-round-button vivic-reminder-trigger" aria-label={active ? `提醒，${active} 条待提醒` : "提醒"}
        title="提醒" data-vivic-open-reminders>
        <Bell size={19} strokeWidth={1.8} aria-hidden="true" />
        {active > 0 && <span className="vivic-reminder-count" aria-hidden="true">{active > 99 ? "99+" : active}</span>}
      </button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content asChild side="bottom" align="start" sideOffset={8} collisionPadding={12}>
        <HarkSurface as="div" className="vh-hark vivic-reminder-surface" data-theme={theme} data-appearance={theme}
          aria-label="提醒中心" data-vivic-reminder-popover>
          <RemindersSection host={host} readonly={disabled} hidePreferences external />
        </HarkSurface>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
