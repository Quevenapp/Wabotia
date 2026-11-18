// Gestão → Ordem de serviço: termos, mensagens ao cliente, validade padrão do
// orçamento, garantia e avisos; e os itens do menu do WhatsApp do módulo.
import React, { useState } from "react";
import { hasWorkMenu } from "../../menu-tree";
import { Check, Plus } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../app/hooks";
import type { Row } from "../../lib/api";
import { Button, Card, Field, Pill } from "../../ui";
import "./os.css";

/** Padrões do servidor (src/modules/os/model.ts, OS_DEFAULTS). */
const defaults: Row = {
  terms:
    "Autorizo a análise do item informado. O orçamento será enviado por este WhatsApp e nenhum serviço será feito sem a minha aprovação.",
  quote_valid_days: 7,
  warranty_days: 90,
  stale_days: 7,
  pickup_reminder_days: 3,
  texts: {
    opened:
      "Ordem de serviço nº {numero} aberta para {item}. Vamos analisar e enviar o orçamento por aqui.",
    approved:
      "Orçamento da ordem nº {numero} aprovado. Avisaremos quando o serviço estiver pronto.",
    declined:
      "Orçamento da ordem nº {numero} recusado. Avisaremos quando {item} estiver disponível para retirada.",
    in_progress: "",
    ready: "Ordem de serviço nº {numero}: {item} está pronto para retirada.",
    delivered:
      "Ordem de serviço nº {numero} entregue. Garantia: {garantia}. Obrigado pela preferência!",
    cancelled: "Ordem de serviço nº {numero} cancelada.",
    pickup_reminder:
      "Lembrete: {item} (ordem de serviço nº {numero}) está pronto para retirada desde {pronto}.",
  },
};

const textFields: [string, string][] = [
  ["opened", "Ordem aberta"],
  ["approved", "Orçamento aprovado"],
  ["declined", "Orçamento recusado"],
  ["in_progress", "Serviço iniciado"],
  ["ready", "Pronta para retirada"],
  ["delivered", "Entregue"],
  ["cancelled", "Cancelada"],
  ["pickup_reminder", "Lembrete de retirada"],
];

const menuTypes = [
  { type: "os_open", label: "Abrir ordem de serviço" },
  { type: "os_track", label: "Acompanhar ordem de serviço" },
];

function merged(saved: Row | undefined): Row {
  return {
    ...defaults,
    ...(saved || {}),
    texts: { ...defaults.texts, ...(saved?.texts || {}) },
  };
}

export function ServiceOrdersSettingsPage() {
  const app = useApp();
  const { busy, run } = useAction();
  const saved = merged(app.settings.service_orders);
  const [draft, setDraft] = useState<Row>(saved);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedGuard(dirty);
  const set =
    (key: string, numeric = false) =>
    (value: string) =>
      setDraft((current) => ({
        ...current,
        [key]: numeric ? (value === "" ? "" : Number(value)) : value,
      }));
  const setText = (key: string) => (value: string) =>
    setDraft((current) => ({
      ...current,
      texts: { ...current.texts, [key]: value },
    }));
  const menus: Row[] = app.settings.menus || [];
  const inMenu = (type: string) => hasWorkMenu(menus, type);
  return (
    <>
      <Card
        title="Como funciona"
        description="A ordem nasce pela conversa (Abrir ordem de serviço), pelo painel (Ordens de serviço) ou pelo próprio cliente no menu do WhatsApp, que preenche item e problema num link e aceita os termos. O orçamento vai ao cliente com Aprovar e Recusar; a cada mudança relevante ele recebe um aviso."
      />
      <Card
        title="Menu do WhatsApp"
        description="Itens que o módulo oferece. Depois de adicionar, ajuste a posição e as linhas em Menus e ações."
      >
        <div className="cards-grid">
          {menuTypes.map((entry) => (
            <section className="card" key={entry.type}>
              <div className="section-heading">
                <h3>{entry.label}</h3>
                <Pill tone={inMenu(entry.type) ? "ok" : "muted"}>
                  {inMenu(entry.type) ? "No menu" : "Fora do menu"}
                </Pill>
              </div>
              {!inMenu(entry.type) && (
                <Button
                  secondary
                  icon={<Plus size={16} />}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      async () => {
                        const latest = await app.api(app.root + "/menus");
                        if (hasWorkMenu(latest.data || [], entry.type)) return;
                        await app.api(app.root + "/settings", "PUT", {
                          menus: [
                            ...(latest.data || []),
                            {
                              id:
                                entry.type.replace("_", "-") +
                                "-" +
                                crypto.randomUUID().slice(0, 6),
                              label: entry.label,
                              type: entry.type,
                              enabled: true,
                            },
                          ],
                          menus_revision: latest.revision,
                        });
                        await app.refresh();
                      },
                      { success: "Item adicionado ao menu." },
                    )
                  }
                >
                  Adicionar ao menu
                </Button>
              )}
            </section>
          ))}
        </div>
      </Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              const texts: Row = {};
              for (const [key] of textFields)
                texts[key] = draft.texts[key] || "";
              await app.api(app.root + "/settings", "PUT", {
                service_orders: {
                  terms: draft.terms,
                  quote_valid_days: Number(draft.quote_valid_days),
                  warranty_days: Number(draft.warranty_days),
                  stale_days: Number(draft.stale_days),
                  pickup_reminder_days: Number(draft.pickup_reminder_days),
                  texts,
                },
              });
              await app.refresh();
            },
            { success: "Configurações salvas." },
          );
        }}
      >
        <Card title="Prazos">
          <div className="form-field-grid">
            <Field
              label="Validade padrão do orçamento (dias)"
              type="number"
              min={1}
              max={90}
              value={draft.quote_valid_days}
              onChange={set("quote_valid_days", true)}
              required
              help="Orçamento vencido não pode ser aprovado; envie de novo."
            />
            <Field
              label="Garantia (dias após a entrega)"
              type="number"
              min={0}
              max={3650}
              value={draft.warranty_days}
              onChange={set("warranty_days", true)}
              required
              help="0 para sem garantia."
            />
            <Field
              label="Lembrar a retirada após (dias)"
              type="number"
              min={0}
              max={365}
              value={draft.pickup_reminder_days}
              onChange={set("pickup_reminder_days", true)}
              required
              help="Uma mensagem ao cliente com a ordem pronta e não retirada. 0 desliga."
            />
            <Field
              label="Ordem parada após (dias)"
              type="number"
              min={1}
              max={365}
              value={draft.stale_days}
              onChange={set("stale_days", true)}
              required
              help="Publica o evento os.stale para a equipe e integrações."
            />
          </div>
        </Card>
        <Card
          title="Termos aceitos pelo cliente"
          description="Mostrados no link de abertura pelo WhatsApp. O texto aceito fica guardado na ordem."
        >
          <Field
            label="Termos"
            type="textarea"
            rows={4}
            value={draft.terms}
            onChange={set("terms")}
            maxLength={1400}
            required
          />
        </Card>
        <Card
          title="Mensagens ao cliente"
          description="Em branco, a mensagem não é enviada. Marcadores: {numero}, {item}, {estado}, {total}, {validade}, {garantia}, {pronto}, {previsao}. Fora da janela de 24 horas, saem pelo modelo de notificação de Regras de atendimento."
        >
          <div className="os-texts">
            {textFields.map(([key, label]) => (
              <Field
                key={key}
                label={label}
                type="textarea"
                rows={2}
                value={draft.texts[key] || ""}
                onChange={setText(key)}
                maxLength={900}
              />
            ))}
          </div>
        </Card>
        <div className="toolbar">
          <span />
          <Button
            type="submit"
            busy={busy}
            disabled={!dirty}
            icon={<Check size={17} />}
          >
            Salvar configurações
          </Button>
        </div>
      </form>
    </>
  );
}
