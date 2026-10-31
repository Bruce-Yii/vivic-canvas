import { Select } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useContext } from "react";
import { ControlOverlayContext } from "./ControlOverlayContext";

/** Existing Radix + shadcn control styling, shared by configuration fields. */
export const Choice = ({ value, onChange, options, disabled, label, testId }: {
  value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }>;
  disabled?: boolean; label: string; testId?: string;
}) => {
  const container = useContext(ControlOverlayContext);
  return <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
  <Select.Trigger asChild><Button variant="outline" aria-label={label} className="min-w-40 justify-between" data-testid={testId}>
    <Select.Value placeholder={label} /><Select.Icon><ChevronDown className="ml-2 size-4" /></Select.Icon>
  </Button></Select.Trigger>
  <Select.Portal container={container ?? undefined}><Select.Content position="popper" sideOffset={4} collisionPadding={12}
    className="z-50 max-h-64 min-w-[var(--radix-select-trigger-width)] overflow-y-auto rounded-md border border-neutral-200 bg-white p-1 text-sm text-neutral-900 shadow-md">
    <Select.Viewport>{options.map(option => <Select.Item key={option.value} value={option.value}
      className="relative flex cursor-default select-none items-center rounded-sm py-2 pl-7 pr-3 outline-none data-[highlighted]:bg-neutral-100">
      <Select.ItemIndicator className="absolute left-2"><Check className="size-3" /></Select.ItemIndicator><Select.ItemText>{option.label}</Select.ItemText>
    </Select.Item>)}</Select.Viewport>
  </Select.Content></Select.Portal>
</Select.Root>;
};
