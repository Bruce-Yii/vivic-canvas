import { useId } from "react";
import { Switch } from "radix-ui";

export function PreferenceToggle({ label, checked, disabled, onChange, testId }: {
  label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void; testId?: string;
}) {
  const id = useId();
  return <div className="se-row"><label htmlFor={id}>{label}</label>
    <Switch.Root id={id} className="se-switch" checked={checked} disabled={disabled} onCheckedChange={onChange} data-testid={testId}>
      <Switch.Thumb />
    </Switch.Root>
  </div>;
}
