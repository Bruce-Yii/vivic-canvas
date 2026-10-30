import { useState } from "react";
import { validateValue, type Json, type JsonObject, type ValueSchema } from "@vivic/card-runtime";

/** Primitive controls plus a validated JSON editor for nested values; no service data editor. */
export function SchemaForm({ schema, value, onChange, label = "参数", onValidityChange }: { schema: ValueSchema; value: JsonObject; onChange: (value: JsonObject) => void; label?: string; onValidityChange?: (valid: boolean) => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const report = (next: Record<string, string>) => { setErrors(next); onValidityChange?.(Object.keys(next).length === 0); };
  const commit = (key: string, next: Json) => {
    const result = { ...value, [key]: next };
    try { validateValue(schema, result, label); const nextErrors = { ...errors }; delete nextErrors[key]; report(nextErrors); onChange(result); }
    catch (cause) { report({ ...errors, [key]: cause instanceof Error ? cause.message : String(cause) }); }
  };
  return <fieldset className="space-y-2 nodrag" data-extension-form={label}>
    <legend className="text-sm font-medium">{label}</legend>
    {Object.entries(schema.properties ?? {}).map(([key, field]) => <label key={key} className="block text-xs">
      <span className="mb-1 block">{field.title ?? key}{schema.required?.includes(key) ? " *" : ""}</span>
      {field.enum ? <select className="vivic-scene-input w-full" value={String(value[key] ?? "")} onChange={event => commit(key, field.enum!.find(v => String(v) === event.target.value) ?? "")}>{field.enum.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</select>
        : field.type === "boolean" ? <input type="checkbox" checked={value[key] === true} onChange={event => commit(key, event.target.checked)} />
          : field.type === "object" || field.type === "array" ? <textarea aria-label={field.title ?? key} className="vivic-scene-input w-full" key={`${key}:${JSON.stringify(value[key])}`} defaultValue={JSON.stringify(value[key] ?? (field.type === "array" ? [] : {}), null, 2)} onBlur={event => {
            try { const parsed: Json = JSON.parse(event.target.value); commit(key, parsed); } catch { report({ ...errors, [key]: `${key}: JSON 格式错误` }); }
          }} />
            : <input aria-label={field.title ?? key} className="vivic-scene-input w-full" type={field.type === "string" ? "text" : "number"}
              key={`${key}:${JSON.stringify(value[key])}`} defaultValue={String(value[key] ?? "")}
              min={field.minimum} max={field.maximum} step={field.type === "integer" ? 1 : "any"} maxLength={field.maxLength}
              onBlur={event => commit(key, field.type === "string" ? event.target.value : Number(event.target.value))} />}
      {field.description && <span className="vivic-scene-muted block">{field.description}</span>}
    </label>)}
    {Object.entries(errors).map(([key, error]) => <p key={key} role="alert" className="text-xs text-red-600">{error}</p>)}
  </fieldset>;
}
