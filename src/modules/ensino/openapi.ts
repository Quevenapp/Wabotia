import { ensinoReads, ensinoWrites } from "./ensino";

const string = { type: "string" }, date = { type: "string", format: "date" };
const version = { type: "integer", minimum: 1 };
const decimal = { type: "number", minimum: 0.01, maximum: 100, multipleOf: 0.01 };
const enumOf = (...values: string[]) => ({ type: "string", enum: values });
const obj = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
export const ensinoSchemas = {
  EnsinoMutation: obj({ id: string, class_id: string, version }),
  EnsinoRule: obj({ method: enumOf("simple", "weighted"), decimals: { type: "integer", minimum: 0, maximum: 2 }, rounding: enumOf("half_up", "truncate", "ceil"),
    recovery: obj({ mode: enumOf("none", "best", "weighted"), base_weight: decimal, recovery_weight: decimal, cap: { type: "number", minimum: 0, maximum: 10, multipleOf: 0.01 } }) }),
};
const rule = { $ref: "#/components/schemas/EnsinoRule" };
const schedule = { type: "array", minItems: 1, maxItems: 20, items: obj({ day: { type: "integer", minimum: 0, maximum: 6 }, start: string, end: string }) };
const input: Record<string, unknown> = {
  "ensino.class.create": obj({ name: string, school_year: string, start_date: date, end_date: date, teacher_id: string, type_id: string, capacity: { type: "integer", minimum: 1, maximum: 100 },
    schedule, periods: { type: "array", minItems: 1, maxItems: 8, items: obj({ id: string, name: string, start: date, end: date }) }, rule, justified_counts: { type: "boolean" } }),
  "ensino.class.update": obj({ version, teacher_id: string, schedule, rule, justified_counts: { type: "boolean" } }, ["version"]),
  "ensino.enrollment.create": obj({ version, order_id: string, start_date: date, end_date: date }),
  "ensino.enrollment.end": obj({ version, end_date: date }),
  "ensino.guardian.grant": obj({ version, person_id: string, valid_until: date, identity_confirmed: { const: true } }),
  "ensino.guardian.revoke": obj({ version }),
  "ensino.lesson.create": obj({ version, date, starts: string, ends: string, status: enumOf("planned", "held", "cancelled"), exception: { type: "boolean" } }, ["version", "date", "starts", "ends", "status"]),
  "ensino.lesson.update": obj({ version, status: enumOf("planned", "held", "cancelled"), reason: { const: "correction" } }),
  "ensino.attendance.record": obj({ version, enrollment_id: string, status: enumOf("present", "absent", "justified"), reason: enumOf("initial", "correction") }),
  "ensino.assessment.create": obj({ version, period_id: string, subject: string, title: string, date, max_score: { type: "number", minimum: 0.01, maximum: 10000, multipleOf: 0.01 }, weight: decimal, kind: enumOf("regular", "recovery") }),
  "ensino.grade.record": obj({ version, enrollment_id: string, status: enumOf("graded", "absent", "exempt"), score: { type: ["number", "null"], minimum: 0, multipleOf: 0.01 }, reason: enumOf("initial", "correction") }),
  "ensino.report.publish": obj({ version, period_id: string }),
  "ensino.notice.create": obj({ version, text: { type: "string", minLength: 1, maxLength: 3000 }, audience_date: date }),
  "ensino.notice.publish": obj({ version, reviewed: { const: true } }),
  "ensino.notice.send": obj({ retry: { type: "boolean" } }, []),
};
const pathOf = (path: string) => "/profiles/{profile}/" + path.replace(/:([a-z_]+)/g, "{$1}");
export const ensinoOperations: [string, string, string, string?, string?][] = [
  ...ensinoReads.map(r => ["get", pathOf(r.path), "Ensino: consulta escolar protegida"] as [string, string, string]),
  ...ensinoWrites.map(r => [r.method.toLowerCase(), pathOf(r.path), `Ensino: ${r.op}`] as [string, string, string]),
];
export function describeEnsinoOperation(path: string, method: string, entry: any, success: any) {
  entry.description = (entry.description ?? "") + " Extensão Ensino, desligada por padrão, requer os. Somente pessoas com papel ensino:secretaria ou professor da turma. Credencial de responsável só nas rotas /access/{id}, emitida pelo WhatsApp e revalidada a cada acesso. Dados nunca retornam à IA. Respostas no-store. Escritas usam Idempotency-Key; version é a versão da turma. Datas civis, intervalo inclusivo. Consulte docs/ENSINO.md.";
  const route = ensinoWrites.find(r => pathOf(r.path) === path && r.method.toLowerCase() === method);
  if (route) {
    entry.requestBody = { required: true, content: { "application/json": { schema: input[route.op] } } };
    success.content["application/json"].schema = route.op === "ensino.notice.send"
      ? obj({ processed: { type: "integer" }, counts: { type: "array", items: obj({ status: enumOf("pending", "queued", "blocked", "cancelled"), total: { type: "integer" } }) } })
      : { $ref: "#/components/schemas/EnsinoMutation" };
  }
  if (method === "get" && (/\/(classes|lessons|assessments)$/.test(path) || path.endsWith("/access/{id}/students"))) {
    entry.parameters = [...(entry.parameters ?? []), { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, { name: "cursor", in: "query", schema: string }];
  }
}
