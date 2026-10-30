import { z } from "zod";
import { ActionEnvelopeSchema } from "./actionEnvelope";
import { CardRecordSchema, CountdownSourceDataSchema, MetadataSchema, NoteCardSchema } from "./cardRecord";
import { ReminderConditionSchema, TimeZoneSchema } from "./reminderSchedule";
import { EvidenceRefSchema } from "./cardCommon";

const baseUrl = "https://vivic.local/contracts/";

/** Generate the public structural contract from the same schemas used by both
 * applications. Cross-record identity and IANA validity still require Zod. */
export function createWireJsonSchemas() {
  const options: NonNullable<Parameters<typeof z.toJSONSchema>[1]> = {
    target: "draft-2020-12",
    override: ({ zodSchema, jsonSchema }) => {
      if (zodSchema === EvidenceRefSchema) jsonSchema.anyOf = [
        { required: ["kind"], properties: { kind: { const: "service" } } }, { required: ["url"] },
      ];
      if (zodSchema === CountdownSourceDataSchema) {
        jsonSchema.not = {
          required: ["schedule", "condition"],
          properties: { schedule: { not: { type: "null" } }, condition: { not: { type: "null" } } },
        };
      }
      if (zodSchema === NoteCardSchema) jsonSchema.anyOf = [{ required: ["text"] }, { required: ["bullets"] }].map(rule => ({
        required: ["displayProps"], properties: { displayProps: rule },
      }));
      if (zodSchema === ReminderConditionSchema) {
        jsonSchema.if = { properties: { kind: { const: "countdown.completed" } }, required: ["kind"] };
        jsonSchema.then = { not: { required: ["itemId"] } };
      }
      for (const name of ["targetIds", "weekdays"]) {
        const field = jsonSchema.properties?.[name];
        if (field && typeof field === "object") field.uniqueItems = true;
      }
      if (zodSchema === TimeZoneSchema) jsonSchema.description = "Valid IANA time zone; also validated by the runtime TimeZoneSchema.";
      if (zodSchema === MetadataSchema) jsonSchema.description = "Subcard IDs must be unique within the parent; enforced by the runtime MetadataSchema.";
    },
  };
  const card = z.toJSONSchema(CardRecordSchema, options);
  card.$id = `${baseUrl}card-record.schema.json`;
  card.title = "Vivic CardRecord v0.6";
  card.description = "Generated from @vivic/contracts. Closed display fields; pure timers render digits, named reminders render their validated task and time. Runtime Zod remains required for semantic and identity checks.";
  const action = z.toJSONSchema(ActionEnvelopeSchema, options);
  action.$id = `${baseUrl}action-envelope.schema.json`;
  action.title = "Vivic ActionEnvelope v0.6";
  action.description = "Generated from @vivic/contracts. card.update merges must be revalidated against the target card type. Target existence, ownership, data provenance and runtime refinements remain required.";
  const actions = action.properties?.actions;
  const item = actions && typeof actions === "object" ? actions.items : undefined;
  if (!item || Array.isArray(item) || typeof item !== "object") throw new Error("Action array schema is missing");
  const create = (item.oneOf ?? item.anyOf)?.find(branch => typeof branch === "object" && branch.properties?.type && typeof branch.properties.type === "object" && branch.properties.type.const === "card.create");
  if (!create || typeof create !== "object" || !create.properties) throw new Error("card.create schema is missing");
  create.properties.card = { $ref: card.$id };
  return { "card-record.schema.json": card, "action-envelope.schema.json": action };
}
