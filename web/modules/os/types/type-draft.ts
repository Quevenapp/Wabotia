import type { CustomWorkType, WorkField } from "../work-contracts";
export function newWorkType(): CustomWorkType {
  return {
    schema_version: 1,
    kind: "custom",
    id: "",
    revision: 1,
    archived: false,
    labels: {
      singular: "Trabalho",
      plural: "Trabalhos",
      item: "Referência",
      problem: "Descrição",
      customer_singular: "Cliente",
      customer_plural: "Clientes",
    },
    number_prefix: "",
    terms: null,
    fields: [],
    retired_field_ids: [],
    retired_stage_ids: [],
    initial_stage: "received",
    stages: [
      {
        id: "received",
        label: "Recebido",
        base_status: "received",
        message: "",
      },
      {
        id: "delivered",
        label: "Concluído",
        base_status: "delivered",
        message: "",
      },
      {
        id: "cancelled",
        label: "Cancelado",
        base_status: "cancelled",
        message: "",
      },
    ],
    transitions: [
      {
        id: "complete",
        from: "received",
        to: "delivered",
        label: "Concluir",
        kind: "manual",
      },
      {
        id: "cancel",
        from: "received",
        to: "cancelled",
        label: "Cancelar",
        kind: "manual",
      },
    ],
    features: {
      customer_open: false,
      tasks: true,
      people: true,
      documents: true,
      entries: true,
      quote: null,
      warranty_days: 0,
      pickup_reminder_days: 0,
      stale_days: 0,
    },
    pickup_reminder_text: "",
  };
}
export function newField(kind: WorkField["kind"] = "text"): WorkField {
  const common = {
    id: "",
    label: "",
    help: "",
    required: false,
    client_visible: false,
    sensitive: false,
  };
  switch (kind) {
    case "text":
      return { ...common, kind, multiline: false, max_length: 200 };
    case "integer":
      return { ...common, kind, min: 0, max: 1000000 };
    case "decimal":
      return { ...common, kind, min: 0, max: 1000000, scale: 2 };
    case "date":
      return { ...common, kind, min: null, max: null };
    case "choice":
      return { ...common, kind, options: [] };
    case "boolean":
      return { ...common, kind };
  }
}
/** Validação de rascunho; a validação normativa final pertence ao servidor. */
export function validateTypeDraft(
  type: CustomWorkType,
  previous?: CustomWorkType,
): string[] {
  const errors: string[] = [];
  const ids = (items: { id: string }[], name: string, limit: number) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (
        !/^[a-z][a-z0-9_]*$/.test(item.id) ||
        item.id.length > limit ||
        ["constructor", "prototype", "__proto__"].includes(item.id)
      )
        errors.push(`${name}: identificador inválido (${item.id}).`);
      if (seen.has(item.id))
        errors.push(`${name}: identificador repetido (${item.id}).`);
      seen.add(item.id);
    }
  };
  ids([type], "Tipo", 64);
  ids(type.fields, "Campo", 32);
  ids(type.stages, "Etapa", 32);
  ids(type.transitions, "Transição", 32);
  if (type.id === "service_order")
    errors.push("O identificador service_order é reservado.");
  if (
    Object.values(type.labels).some(
      (value) => !value.trim() || [...value.trim()].length > 80,
    )
  )
    errors.push(
      "Vocabulário: preencha todos os rótulos com até 80 caracteres.",
    );
  if (
    type.fields.length > 24 ||
    type.stages.length > 32 ||
    type.transitions.length > 128
  )
    errors.push("Limite de campos, etapas ou transições excedido.");
  if (new TextEncoder().encode(JSON.stringify(type)).length > 12 * 1024)
    errors.push("O tipo excede 12 KiB.");
  for (const field of type.fields) {
    if (field.sensitive && (field.required || field.client_visible))
      errors.push(
        `${field.id}: campo sensível não pode ser obrigatório ou visível ao cliente.`,
      );
    if (
      type.features.customer_open &&
      field.required &&
      (!field.client_visible || field.sensitive)
    )
      errors.push(
        `${field.id}: a abertura pelo cliente exige campos obrigatórios públicos.`,
      );
    if (type.retired_field_ids.includes(field.id))
      errors.push(`${field.id}: identificador aposentado.`);
    if (field.kind === "choice") {
      ids(field.options, `Opções de ${field.id}`, 32);
      if (!field.options.length || field.options.length > 32)
        errors.push(`${field.id}: informe de 1 a 32 opções.`);
    }
    if (
      previous?.fields.find((old) => old.id === field.id)?.sensitive &&
      !field.sensitive
    )
      errors.push(`${field.id}: a classificação sensível é permanente.`);
  }
  const stages = new Map(type.stages.map((stage) => [stage.id, stage]));
  if (stages.get(type.initial_stage)?.base_status !== "received")
    errors.push("A etapa inicial precisa usar o estado received.");
  for (const stage of type.stages) {
    if (type.retired_stage_ids.includes(stage.id))
      errors.push(`${stage.id}: etapa aposentada.`);
    if (
      ["quoted", "approved", "declined"].includes(stage.base_status) &&
      !type.features.quote
    )
      errors.push(`${stage.id}: estado reservado ao orçamento.`);
    if (
      ["delivered", "cancelled"].includes(stage.base_status) &&
      type.transitions.some((t) => t.from === stage.id)
    )
      errors.push(`${stage.id}: etapa terminal não pode ter saídas.`);
  }
  for (const t of type.transitions)
    if (!stages.has(t.from) || !stages.has(t.to) || t.from === t.to)
      errors.push(`${t.id}: origem ou destino inválido.`);
  // O protocolo de orçamento também tem arestas; não pode virar transição manual.
  const quote = type.features.quote;
  const edges = [
    ...type.transitions,
    ...(quote
      ? [
          ...quote.source_stages.map((from) => ({
            from,
            to: quote.sent_stage,
          })),
          ...[
            quote.approved_stage,
            quote.declined_stage,
            quote.edited_stage,
          ].map((to) => ({ from: quote.sent_stage, to })),
        ]
      : []),
  ];
  const reachable = (start: string) => {
    const seen = new Set([start]);
    for (let i = 0; i < type.stages.length; i++)
      for (const t of edges) if (seen.has(t.from)) seen.add(t.to);
    return seen;
  };
  const initial = reachable(type.initial_stage);
  for (const stage of type.stages) {
    if (!initial.has(stage.id)) errors.push(`${stage.id}: etapa inalcançável.`);
    if (!["delivered", "cancelled"].includes(stage.base_status)) {
      const destinations = [...reachable(stage.id)].map(
        (id) => stages.get(id)?.base_status,
      );
      if (
        !destinations.includes("delivered") ||
        !destinations.includes("cancelled")
      )
        errors.push(`${stage.id}: falta caminho de conclusão ou cancelamento.`);
    }
  }
  const allowed = messageMarkers(type);
  const messages = [
    ...type.stages.map((stage) => [stage.id, stage.message]),
    ["retirada", type.pickup_reminder_text],
    ...type.transitions
      .filter((t) => t.kind === "customer_approval")
      .map((t) => [t.id, t.kind === "customer_approval" ? t.request_text : ""]),
  ];
  for (const [id, text] of messages)
    for (const match of text.matchAll(/\{([^{}]+)\}/g))
      if (!allowed.has(match[1]))
        errors.push(`${id}: marcador não permitido (${match[1]}).`);
  return errors;
}
export function prepareTypeSave(
  type: CustomWorkType,
  previous?: CustomWorkType,
): CustomWorkType {
  const next = {
    ...type,
    retired_field_ids: [
      ...new Set([
        ...type.retired_field_ids,
        ...(previous?.fields
          .filter((field) => !type.fields.some((f) => f.id === field.id))
          .map((field) => field.id) || []),
      ]),
    ],
    retired_stage_ids: [
      ...new Set([
        ...type.retired_stage_ids,
        ...(previous?.stages
          .filter((stage) => !type.stages.some((s) => s.id === stage.id))
          .map((stage) => stage.id) || []),
      ]),
    ],
  };
  next.revision = previous
    ? JSON.stringify({ ...next, revision: previous.revision }) ===
      JSON.stringify(previous)
      ? previous.revision
      : previous.revision + 1
    : 1;
  return next;
}
export function parseTypeImport(text: string): CustomWorkType {
  if (new TextEncoder().encode(text).length > 12 * 1024)
    throw new Error("O tipo excede 12 KiB.");
  const value = JSON.parse(text);
  if (
    !value ||
    value.schema_version !== 1 ||
    value.kind !== "custom" ||
    !value.labels ||
    !value.features ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.stages) ||
    !Array.isArray(value.transitions) ||
    !Array.isArray(value.retired_field_ids) ||
    !Array.isArray(value.retired_stage_ids)
  )
    throw new Error(
      "Formato de tipo inválido. Use um tipo personalizado com schema_version 1.",
    );
  const strings = (object: Record<string, unknown>, keys: string[]) =>
    keys.every((key) => typeof object[key] === "string");
  if (
    !strings(value, [
      "id",
      "number_prefix",
      "initial_stage",
      "pickup_reminder_text",
    ]) ||
    !strings(value.labels, [
      "singular",
      "plural",
      "item",
      "problem",
      "customer_singular",
      "customer_plural",
    ]) ||
    !value.fields.every(
      (field: WorkField) =>
        field &&
        strings(field as unknown as Record<string, unknown>, [
          "id",
          "label",
          "help",
        ]) &&
        ["text", "integer", "decimal", "boolean", "date", "choice"].includes(
          field.kind,
        ) &&
        (field.kind !== "choice" ||
          (Array.isArray(field.options) &&
            field.options.every(
              (option) => option && strings(option, ["id", "label"]),
            ))),
    ) ||
    !value.stages.every(
      (stage: Record<string, unknown>) =>
        stage && strings(stage, ["id", "label", "base_status", "message"]),
    ) ||
    !value.transitions.every(
      (transition: Record<string, unknown>) =>
        transition &&
        strings(transition, ["id", "from", "to", "label", "kind"]) &&
        (transition.kind === "manual" ||
          (transition.kind === "customer_approval" &&
            typeof transition.request_text === "string")),
    )
  )
    throw new Error(
      "Formato de tipo inválido: confira rótulos, campos, etapas e transições.",
    );
  const errors = validateTypeDraft(value);
  if (errors.length) throw new Error(errors.join("\n"));
  return value;
}
export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2) + "\n"], {
      type: "application/json",
    }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Apenas marcadores públicos entram em mensagens configuradas. */
export function messageMarkers(type: CustomWorkType) {
  return new Set([
    "numero",
    "item",
    "estado",
    "total",
    "validade",
    "garantia",
    "pronto",
    "previsao",
    "tipo",
    "etapa",
    "numero_tipo",
    "identificador",
    ...type.fields
      .filter((field) => field.client_visible && !field.sensitive)
      .map((field) => `campo_${field.id}`),
  ]);
}
export function messagePreview(text: string, type: CustomWorkType) {
  const values: Record<string, string> = {
    numero: "123",
    numero_tipo: "1",
    identificador: type.number_prefix + "1",
    tipo: type.labels.singular,
    etapa: type.stages[0]?.label || "Inicial",
    item: "Exemplo",
    estado: "Recebida",
    total: "R$ 100,00",
    validade: "01/12/2026",
    garantia: "01/12/2026",
    pronto: "01/12/2026",
    previsao: "01/12/2026",
  };
  return text.replace(/\{([^{}]+)\}/g, (marker, key: string) =>
    messageMarkers(type).has(key) ? values[key] || "Exemplo" : marker,
  );
}
