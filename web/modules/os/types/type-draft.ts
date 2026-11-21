import type { CustomWorkType, ServiceObjectType, WorkField } from "../work-contracts";
import { validateObjectType, validateWorkObjectCombination, validateWorkType, validateWorkTypeChanges } from "../../../../src/modules/os/validation";
// Conteúdo parcial pertence ao rascunho, nunca ao DTO enviado ao servidor.
export type WorkFieldDraft = WorkField & { options_text?: string };
/** Identificadores sugeridos pelo rótulo, sem reutilizar IDs já usados. */
export function labelIdentifier(label: string, used: readonly string[] = [], limit = 32): string {
  let base = label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[a-z]/.test(base)) base = "campo_" + base;
  if (["constructor", "prototype", "__proto__", "service_order"].includes(base)) base = "modelo_" + base;
  base = base.slice(0, limit);
  let id = base;
  for (let suffix = 2; used.includes(id); suffix++) {
    const tail = "_" + suffix;
    id = base.slice(0, limit - tail.length) + tail;
  }
  return id;
}
export function renameStage(type: CustomWorkType, index: number, id: string, label = type.stages[index].label): CustomWorkType {
  const old = type.stages[index].id;
  const replace = (value: string) => old && value === old ? id : value;
  const quote = type.features.quote;
  return {
    ...type,
    initial_stage: replace(type.initial_stage),
    stages: type.stages.map((stage, i) => i === index ? { ...stage, id, label } : stage),
    transitions: type.transitions.map((transition) => ({ ...transition, from: replace(transition.from), to: replace(transition.to) })),
    ...(type.stage_field_rules === undefined ? {} : {
      stage_field_rules: type.stage_field_rules.map((rule) => ({
        ...rule,
        ...(rule.required_from_stage === undefined ? {} : { required_from_stage: replace(rule.required_from_stage) }),
        ...(rule.required_on_exit === undefined ? {} : { required_on_exit: rule.required_on_exit.map(replace) }),
      })),
    }),
    features: { ...type.features, quote: quote ? {
      ...quote,
      source_stages: quote.source_stages.map(replace),
      sent_stage: replace(quote.sent_stage), approved_stage: replace(quote.approved_stage),
      declined_stage: replace(quote.declined_stage), edited_stage: replace(quote.edited_stage),
    } : null },
  };
}
export function prepareField(field: WorkFieldDraft): WorkField {
  const { options_text, ...saved } = field;
  if (saved.kind !== "choice" || options_text === undefined) return saved;
  return {
    ...saved,
    options: options_text.split("\n").map((line) => {
      const [id, ...parts] = line.split(":");
      return { id: id.trim(), label: parts.join(":").trim() };
    }),
  };
}
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
  ids([type], "Modelo", 64);
  ids(type.fields, "Campo", 32);
  ids(type.stages, "Etapa", 32);
  ids(type.transitions, "Transição", 32);
  // OS6: checklist por etapa, as mesmas regras do servidor.
  for (const stage of type.stages) {
    const items = stage.checklist ?? [];
    ids(items, `Checklist de ${stage.label || stage.id}`, 32);
    if (items.length > 20) errors.push(`${stage.label || stage.id}: até 20 itens no checklist.`);
    if (items.some((item) => !item.label.trim() || [...item.label.trim()].length > 120))
      errors.push(`${stage.label || stage.id}: escreva cada item do checklist com até 120 caracteres.`);
    if (items.length && ["delivered", "cancelled"].includes(stage.base_status))
      errors.push(`${stage.label || stage.id}: etapa encerrada não tem checklist.`);
    if (items.some((item) => item.photo_required) && !type.features.documents)
      errors.push(`${stage.label || stage.id}: para pedir foto no checklist, ligue Documentos nos recursos do modelo.`);
  }
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
    errors.push("O modelo excede 12 KiB.");
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
    const oldField = previous?.fields.find((old) => old.id === field.id);
    if (oldField && oldField.kind !== field.kind)
      errors.push(`${field.label}: mudar o formato exige outro identificador. Aposente este campo e crie outro.`);
  }
  const stages = new Map(type.stages.map((stage) => [stage.id, stage]));
  for (const rule of type.stage_field_rules ?? []) {
    const field = type.fields.find((entry) => entry.id === rule.field_id);
    if (!field) errors.push(`${rule.field_id}: exigências por etapa pertencem somente a campos desta ordem.`);
    if (field?.sensitive) errors.push(`${field.label}: campo sensível não pode receber exigências por etapa.`);
    if (!rule.required_from_stage && !rule.required_on_exit?.length)
      errors.push(`${rule.field_id}: selecione uma etapa de entrada ou saída.`);
    if (rule.required_from_stage && !stages.has(rule.required_from_stage))
      errors.push(`${rule.field_id}: a etapa de entrada foi removida; revise a exigência.`);
    if (rule.required_on_exit?.some((id) => !stages.has(id)))
      errors.push(`${rule.field_id}: uma etapa de saída foi removida; revise a exigência.`);
    if (type.features.customer_open && rule.required_from_stage === type.initial_stage && field && !field.client_visible)
      errors.push(`${field.label}: a abertura pelo cliente exige campos obrigatórios públicos.`);
  }
  if ((type.list_fields ?? []).filter((rule) => rule.column).length > 4)
    errors.push("Selecione no máximo quatro colunas próprias por modelo.");
  if ((type.list_fields ?? []).filter((rule) => rule.filter).length > 4)
    errors.push("Selecione no máximo quatro campos filtráveis por modelo.");
  for (const rule of type.list_fields ?? []) {
    if (rule.ref.scope === "object") {
      if (!type.object_type_id) errors.push("Selecione um objeto do serviço antes de usar suas colunas ou filtros.");
      continue;
    }
    const field = type.fields.find((entry) => entry.id === rule.ref.field_id);
    if (!field) errors.push(`${rule.ref.field_id}: a coluna ou filtro aponta para um campo removido.`);
    if (field?.sensitive) errors.push(`${field.label}: campo sensível não pode ser coluna ou filtro.`);
    if (rule.filter && field?.kind === "text" && (field.multiline || field.max_length > 240))
      errors.push(`${field.label}: filtro de texto exige uma linha e limite de até 240 caracteres.`);
  }
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
  let next: CustomWorkType = {
    ...type,
    fields: type.fields.map(prepareField),
    retired_field_ids: [
      ...new Set([
        ...type.retired_field_ids,
        ...(previous?.retired_field_ids ?? []),
        ...(previous?.fields
          .filter((field) => !type.fields.some((f) => f.id === field.id))
          .map((field) => field.id) || []),
      ]),
    ],
    retired_stage_ids: [
      ...new Set([
        ...type.retired_stage_ids,
        ...(previous?.retired_stage_ids ?? []),
        ...(previous?.stages
          .filter((stage) => !type.stages.some((s) => s.id === stage.id))
          .map((stage) => stage.id) || []),
      ]),
    ],
  };
  // A revisão compara o conteúdo que o servidor efetivamente persiste.
  // Rascunhos incompletos continuam disponíveis para mostrar os erros no editor.
  try { next = validateWorkType(next); } catch { /* Ainda em edição. */ }
  next.revision = previous
    ? canonical({ ...next, revision: previous.revision }) ===
      canonical(previous)
      ? previous.revision
      : previous.revision + 1
    : 1;
  return next;
}
export function parseTypeImport(text: string): CustomWorkType {
  if (new TextEncoder().encode(text).length > 12 * 1024)
    throw new Error("O modelo excede 12 KiB.");
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
      "Formato de modelo inválido. Use um modelo personalizado com schema_version 1.",
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
      "Formato de modelo inválido: confira rótulos, campos, etapas e transições.",
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
    "objeto",
    ...type.fields
      .filter((field) => field.client_visible && !field.sensitive)
      .map((field) => `campo_${field.id}`),
  ]);
}
export function messagePreview(text: string, type: CustomWorkType, objectType?: ServiceObjectType) {
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
    objeto: type.object_type_id ? `${objectType?.labels.singular || "Objeto"} · 7D2A91` : "",
  };
  return text.replace(/\{([^{}]+)\}/g, (marker, key: string) =>
    messageMarkers(type).has(key) ? values[key] ?? "Exemplo" : marker,
  );
}

/** Compara conteúdo, não a ordem das propriedades do JSON importado. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]])) : entry);
}

export interface ConfigurationDefinitions {
  os_work_types?: CustomWorkType[];
  os_object_types?: ServiceObjectType[];
}
export interface ConfigurationSavePayload {
  os_work_types: CustomWorkType[];
  os_object_types?: ServiceObjectType[];
  settings_revision: string;
}

export function newObjectType(usedIds: readonly string[] = []): ServiceObjectType {
  return {
    schema_version: 1,
    id: labelIdentifier("Objeto", usedIds, 64),
    revision: 1,
    archived: false,
    labels: { singular: "Objeto", plural: "Objetos" },
    identifier_field_id: "identificacao",
    fields: [{
      ...newField("text"), kind: "text", multiline: false, max_length: 120,
      id: "identificacao", label: "Identificação", help: "Identificação de apresentação; não comprova propriedade.",
    }],
    retired_field_ids: [],
  };
}

export function prepareObjectTypeSave(type: ServiceObjectType, previous?: ServiceObjectType): ServiceObjectType {
  let next: ServiceObjectType = {
    ...type,
    fields: type.fields.map(prepareField),
    retired_field_ids: [...new Set([
      ...type.retired_field_ids,
      ...(previous?.retired_field_ids ?? []),
      ...(previous?.fields.filter((field) => !type.fields.some((entry) => entry.id === field.id)).map((field) => field.id) ?? []),
    ])],
  };
  try { next = validateObjectType(next); } catch { /* Ainda em edição. */ }
  next.revision = previous ? previous.revision + Number(
    canonical({ ...next, revision: 0 }) !== canonical({ ...previous, revision: 0 }),
  ) : 1;
  return next;
}

function preparedDefinitions(workTypes: CustomWorkType[], objectTypes: ServiceObjectType[] | undefined, previous: ConfigurationDefinitions): ConfigurationDefinitions & { os_work_types: CustomWorkType[] } {
  return {
    os_work_types: workTypes.map((type) => prepareTypeSave(type, previous.os_work_types?.find((entry) => entry.id === type.id))),
    ...(objectTypes === undefined ? {} : {
      os_object_types: objectTypes.map((type) => prepareObjectTypeSave(type, previous.os_object_types?.find((entry) => entry.id === type.id))),
    }),
  };
}

/** Confere também modelos que compartilham o tipo de objeto editado. */
export function validateConfigurationDraft(
  workTypes: CustomWorkType[],
  objectTypes: ServiceObjectType[] | undefined,
  previous: ConfigurationDefinitions = {},
): string[] {
  const next = preparedDefinitions(workTypes, objectTypes, previous);
  const objects = next.os_object_types ?? previous.os_object_types ?? [];
  const errors: string[] = [];
  if (workTypes.length > 20) errors.push("A área admite até 20 modelos, incluindo os arquivados.");
  if (objects.length > 20) errors.push("A área admite até 20 tipos de objeto, incluindo os arquivados.");
  for (const type of next.os_work_types) {
    errors.push(...validateTypeDraft(type, previous.os_work_types?.find((entry) => entry.id === type.id)).map((error) => `${type.labels.singular}: ${error}`));
    if (type.object_type_id && !objects.some((entry) => entry.id === type.object_type_id))
      errors.push(`${type.labels.singular}: selecione um tipo de objeto cadastrado nesta área.`);
    const objectType = objects.find((entry) => entry.id === type.object_type_id);
    if (objectType) {
      if (objectType.fields.length + type.fields.length > 24)
        errors.push(`${type.labels.singular}: objeto e ordem juntos admitem até 24 campos. Revise os modelos compartilhados.`);
      for (const rule of type.list_fields ?? []) {
        if (rule.ref.scope !== "object") continue;
        const field = objectType.fields.find((entry) => entry.id === rule.ref.field_id);
        if (!field) errors.push(`${type.labels.singular}: a referência ao campo do objeto ${rule.ref.field_id} precisa ser revista.`);
        if (field?.sensitive) errors.push(`${type.labels.singular}: ${field.label} é sensível e não pode ser coluna ou filtro.`);
        if (rule.filter && field?.kind === "text" && (field.multiline || field.max_length > 240))
          errors.push(`${type.labels.singular}: ${field.label} exige texto de uma linha com até 240 caracteres para ser filtro.`);
      }
      if (type.features.customer_open && objectType.fields.some((field) => field.required && !field.client_visible))
        errors.push(`${type.labels.singular}: campos obrigatórios no cadastro do objeto precisam ser públicos para abertura pelo cliente.`);
    }
  }
  for (const objectType of objects) {
    const identifier = objectType.fields.find((field) => field.id === objectType.identifier_field_id);
    if (!identifier || identifier.kind !== "text" || identifier.multiline || identifier.sensitive || identifier.max_length > 120)
      errors.push(`${objectType.labels.singular}: escolha um identificador de texto, uma linha, não sensível e com até 120 caracteres.`);
    if (objectType.fields.length > 24) errors.push(`${objectType.labels.singular}: o tipo de objeto admite até 24 campos.`);
    if (new TextEncoder().encode(JSON.stringify(objectType)).length > 8 * 1024)
      errors.push(`${objectType.labels.singular}: a definição excede 8 KiB. Reduza campos ou textos.`);
    const old = previous.os_object_types?.find((entry) => entry.id === objectType.id);
    for (const field of objectType.fields) {
      if (objectType.retired_field_ids.includes(field.id)) errors.push(`${objectType.labels.singular}: ${field.id} é um identificador aposentado.`);
      if (field.sensitive && (field.required || field.client_visible))
        errors.push(`${field.label}: campo sensível não pode ser obrigatório ou visível ao cliente.`);
      if (old?.fields.find((entry) => entry.id === field.id)?.sensitive && !field.sensitive)
        errors.push(`${field.label}: a classificação sensível é permanente. Use outro identificador para outro significado.`);
      const oldField = old?.fields.find((entry) => entry.id === field.id);
      if (oldField && oldField.kind !== field.kind)
        errors.push(`${field.label}: mudar o formato exige outro identificador. Aposente este campo e crie outro.`);
    }
  }
  // Mesmos validadores normativos usados pelo servidor: tipos, referências,
  // limites, privacidade, aposentadoria e revisão permanecem sincronizados.
  try {
    validateWorkTypeChanges(previous, { ...next, os_object_types: objects });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Configuração inválida. Revise os campos e suas referências.");
  }
  return [...new Set(errors)];
}

export function prepareConfigurationSave(
  workTypes: CustomWorkType[],
  objectTypes: ServiceObjectType[] | undefined,
  previous: ConfigurationDefinitions,
  settingsRevision: string,
): ConfigurationSavePayload {
  const errors = validateConfigurationDraft(workTypes, objectTypes, previous);
  if (errors.length) throw new Error(errors.join("\n"));
  return { ...preparedDefinitions(workTypes, objectTypes, previous), settings_revision: settingsRevision };
}

/** A mudança é somente da definição; valores históricos nunca entram neste plano. */
export function moveFieldLocation(
  type: CustomWorkType,
  objectType: ServiceObjectType,
  from: "order" | "object",
  fieldId: string,
  destinationId?: string,
): { work_type: CustomWorkType; object_type: ServiceObjectType } {
  if (type.kind !== "custom" || type.id === "service_order" || type.object_type_id !== objectType.id)
    throw new Error("Selecione um tipo de objeto para este modelo personalizado antes de mover campos.");
  const source = from === "order" ? type : objectType;
  const destination = from === "order" ? objectType : type;
  const field = source.fields.find((entry) => entry.id === fieldId);
  if (!field) throw new Error("O campo de origem não existe nesta definição.");
  if (from === "object" && objectType.identifier_field_id === fieldId)
    throw new Error("Escolha outro identificador do objeto antes de mudar a localização deste campo.");
  if (from === "order" && type.stage_field_rules?.some((rule) => rule.field_id === fieldId))
    throw new Error("Campos do objeto não aceitam exigências por etapa. Remova a exigência antes de mudar a localização.");
  const targetId = destinationId ?? fieldId;
  if (destination.retired_field_ids.includes(targetId))
    throw new Error("O identificador de destino está aposentado. Informe um novo identificador.");
  const existing = destination.fields.find((entry) => entry.id === targetId);
  if (existing && destinationId === undefined)
    throw new Error("Este identificador já existe no destino. Selecione explicitamente o campo compartilhado para referenciá-lo.");
  const meaning = (entry: WorkField) => {
    const { id: _id, label: _label, help: _help, ...content } = prepareField(entry);
    return content;
  };
  if (existing && canonical(meaning(field)) !== canonical(meaning(existing)))
    throw new Error("O campo de destino tem significado, validação ou privacidade diferente. Crie um campo com outro identificador.");
  const work = structuredClone(type), object = structuredClone(objectType);
  const nextSource = from === "order" ? work : object;
  const nextDestination = from === "order" ? object : work;
  nextSource.fields = nextSource.fields.filter((entry) => entry.id !== fieldId);
  nextSource.retired_field_ids = [...new Set([...nextSource.retired_field_ids, fieldId])];
  if (!existing) nextDestination.fields.push({ ...prepareField(field), id: targetId });
  if (work.list_fields) {
    const combined = new Map<string, NonNullable<CustomWorkType["list_fields"]>[number]>();
    for (const rule of work.list_fields) {
      const updated = rule.ref.scope === from && rule.ref.field_id === fieldId
        ? { ...rule, ref: { scope: from === "order" ? "object" as const : "order" as const, field_id: targetId } } : rule;
      const key = `${updated.ref.scope}:${updated.ref.field_id}`;
      const other = combined.get(key);
      combined.set(key, other ? {
        ref: updated.ref,
        ...(other.column || updated.column ? { column: true } : {}),
        ...(other.filter || updated.filter ? { filter: true } : {}),
      } : updated);
    }
    work.list_fields = [...combined.values()];
  }
  validateWorkObjectCombination(validateWorkType(prepareTypeSave(work)), validateObjectType(prepareObjectTypeSave(object)));
  return { work_type: work, object_type: object };
}

export function exportConfiguration(type: CustomWorkType, objectTypes: readonly ServiceObjectType[]) {
  const work = structuredClone({ ...type, fields: type.fields.map(prepareField) });
  if (!type.object_type_id) return work;
  const objectType = objectTypes.find((entry) => entry.id === type.object_type_id);
  if (!objectType) throw new Error("O tipo de objeto referenciado não está disponível nesta área.");
  const object = structuredClone({ ...objectType, fields: objectType.fields.map(prepareField) });
  return { schema_version: 1 as const, work_type: work, object_types: [object] };
}

export function parseConfigurationImport(text: string): { work_type: CustomWorkType; object_types?: ServiceObjectType[] } {
  // O arquivo formatado é maior que a definição compacta validada abaixo.
  if (new TextEncoder().encode(text).length > 128 * 1024)
    throw new Error("O arquivo de modelo com objeto excede 128 KiB.");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("work_type" in value))
    return { work_type: parseTypeImport(text) };
  const bundle = value as { schema_version?: unknown; work_type: unknown; object_types?: unknown };
  if (bundle.schema_version !== 1 || !Array.isArray(bundle.object_types) || bundle.object_types.length !== 1)
    throw new Error("Formato inválido: inclua o modelo e exatamente o tipo de objeto referenciado.");
  const work = parseTypeImport(JSON.stringify(bundle.work_type));
  const objects = bundle.object_types.map(validateObjectType);
  if (work.object_type_id !== objects[0].id)
    throw new Error("O objeto importado não corresponde à referência deste modelo.");
  validateWorkObjectCombination(validateWorkType(work), objects[0]);
  return { work_type: work, object_types: objects };
}
