import type { AreaTemplate } from "../../modules/os/work-contracts";
import { parseTypeImport } from "../../modules/os/types/type-draft";
/** Confere a estrutura antes de renderizar; regras de aplicação ficam na prévia. */
export function parseAreaTemplate(text: string): AreaTemplate {
  if (new TextEncoder().encode(text).length > 128 * 1024)
    throw new Error("O modelo excede 128 KiB.");
  const value = JSON.parse(text);
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  const stringList = (item: unknown) =>
    Array.isArray(item) && item.every((value) => typeof value === "string");
  const textRecord = (item: unknown) =>
    record(item) &&
    Object.values(item).every((value) => typeof value === "string");
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    !Number.isSafeInteger(value.version) ||
    !Array.isArray(value.work_types) ||
    !record(value.modules) ||
    !Object.values(value.modules).every((item) => typeof item === "boolean") ||
    !textRecord(value.vocabulary) ||
    !textRecord(value.texts) ||
    !Array.isArray(value.menus) ||
    !value.menus.every(
      (menu) =>
        record(menu) &&
        typeof menu.id === "string" &&
        typeof menu.label === "string" &&
        typeof menu.type === "string" &&
        (!("type_id" in menu) || typeof menu.type_id === "string"),
    ) ||
    !Array.isArray(value.departments) ||
    !value.departments.every(
      (item) => record(item) && typeof item.name === "string",
    ) ||
    !Array.isArray(value.ticket_categories) ||
    !value.ticket_categories.every(
      (item) => record(item) && typeof item.name === "string",
    ) ||
    !record(value.bot) ||
    typeof value.bot.instructions !== "string" ||
    !stringList(value.bot.allowed_operations) ||
    !stringList(value.bot.denied_operations) ||
    !stringList(value.bot.suggested_roles) ||
    !stringList(value.manual_steps)
  )
    throw new Error("Manifesto inválido. Confira os blocos do modelo.");
  for (const type of value.work_types) parseTypeImport(JSON.stringify(type));
  return value as unknown as AreaTemplate;
}
