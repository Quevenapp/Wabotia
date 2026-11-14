// Atendente e especialistas: bots do Hermes, linhas de cada bot e as ações
// internas que o Atendente pode pedir a um especialista.
import React, { useEffect, useState } from "react";
import { ArrowRight, Bot, Check, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Badge, Button, CopyButton, Empty, Field, toast } from "../ui";
import { BotLinesEditor } from "../ServicePanels";
import { FormDialog } from "./shared";

function CapabilityDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [form, setForm] = useState<Row>({});
  const change = (key: string) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  return (
    <FormDialog
      title="Ação de especialista"
      onClose={onClose}
      onSubmit={async () => {
        await app.api(app.root + "/settings", "PUT", {
          capabilities: [
            ...(app.settings.capabilities || []),
            { ...form, id: crypto.randomUUID(), enabled: true },
          ],
        });
        toast("Salvo com sucesso.");
        await app.refresh();
        onClose();
      }}
    >
      <Field label="Nome" value={form.name} onChange={change("name")} required />
      <Field
        label="Especialista Hermes"
        value={form.bot_id}
        onChange={change("bot_id")}
        options={app.bots.filter((bot) => bot.connection_kind !== "ai")}
        help="Só bots do Hermes executam ações. Bots de provedor de IA só conversam."
      />
      <Field
        label="Quando consultar este especialista"
        type="textarea"
        value={form.condition}
        onChange={change("condition")}
      />
      <Field
        label="Ação permitida"
        type="textarea"
        value={form.instructions}
        onChange={change("instructions")}
      />
    </FormDialog>
  );
}

export function BotsPage() {
  const app = useApp();
  const { api, root, demo, bots, settings } = app;
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false),
    [renaming, setRenaming] = useState<Row | null>(null),
    [name, setName] = useState("");
  useEffect(() => setName(renaming?.name || ""), [renaming?.id]);
  const save = (fn: () => Promise<any>) =>
    run(fn, { success: "Salvo com sucesso." }).then(() => app.refresh());
  return (
    <>
      <section className="card">
        <h2>O Atendente conversa. Os especialistas executam.</h2>
        <p className="workspace-help">
          Escolha um bot principal para receber o cliente. Em uma ação interna,
          ele consulta outro bot do Hermes e recebe o resultado para responder.
          Por exemplo: o especialista financeiro do Fagoo usa suas próprias
          credenciais para buscar a segunda via de um boleto.
        </p>
        <div className="service-flow">
          <span>Bot Atendente</span>
          <ArrowRight size={16} />
          <span>Especialista no Hermes</span>
          <ArrowRight size={16} />
          <span>API do sistema</span>
        </div>
      </section>
      <div className="toolbar">
        <p>
          Selecione os bots do Hermes ou de um provedor de IA. Permissões do
          Hermes continuam no atendimento original.
        </p>
        <Button onClick={() => setAdding(true)} icon={<Plus size={17} />}>
          Ação de especialista
        </Button>
      </div>
      <div className="cards-grid">
        {bots.map((bot) => (
          <section className="card" key={bot.id}>
            <div className="section-heading">
              <span className="integration-icon">
                <Bot />
              </span>
              <Badge value={bot.enabled ? "enabled" : "disabled"} />
            </div>
            <h2>{bot.name}</h2>
            <p>
              {bot.connection_kind === "ai"
                ? `Provedor de IA: ${bot.model || bot.provider || ""}. Conversa, sem ferramentas.`
                : `Atendimento Hermes: ${bot.remote_profile}`}
            </p>
            <div className="card-actions">
              <Button
                secondary
                disabled={busy}
                onClick={() =>
                  save(() =>
                    api(root + "/bots/" + bot.id, "PATCH", {
                      enabled: !bot.enabled,
                    }),
                  )
                }
              >
                {bot.enabled ? "Desabilitar" : "Habilitar"}
              </Button>
              {app.isAdmin && (
                <Button
                  secondary
                  disabled={busy}
                  onClick={() => setRenaming(bot)}
                >
                  Renomear
                </Button>
              )}
            </div>
            <button
              type="button"
              className="text-link block"
              disabled={busy}
              onClick={() =>
                save(() =>
                  api(root + "/settings", "PUT", { attendant_bot: bot.id }),
                )
              }
            >
              {settings.attendant_bot === bot.id ? (
                <>
                  <Check size={15} /> Bot Atendente selecionado
                </>
              ) : (
                "Usar como Bot Atendente"
              )}
            </button>
            <small className="resource-id">
              {bot.id}
              <CopyButton value={bot.id} />
            </small>
            {app.isAdmin && (
              <BotLinesEditor
                key={bot.id}
                bot={bot}
                api={api}
                root={root}
                demo={demo}
              />
            )}
          </section>
        ))}
      </div>
      {app.statusLoaded && !bots.length && (
        <div className="card">
          <Empty
            icon={<Bot size={28} />}
            title="Sua Equipe Bot começa em Hermes e canais"
            description="Cadastre o Hermes e use Descobrir bots, ou conecte um provedor de IA e use Testar conexão."
          />
        </div>
      )}
      <section className="card">
        <h2>Ações internas permitidas</h2>
        {(settings.capabilities || []).map((action: Row) => (
          <div className="connection-row" key={action.id}>
            <div>
              <strong>{action.name}</strong>
              <small>{action.condition}</small>
            </div>
            <Button
              secondary
              disabled={busy}
              onClick={() =>
                save(() =>
                  api(root + "/settings", "PUT", {
                    capabilities: settings.capabilities.filter(
                      (item: Row) => item.id !== action.id,
                    ),
                  }),
                )
              }
            >
              Remover
            </Button>
          </div>
        ))}
        {!settings.capabilities?.length && (
          <p>
            Adicione uma ação para permitir que o Atendente consulte um
            especialista.
          </p>
        )}
      </section>
      {adding && <CapabilityDialog onClose={() => setAdding(false)} />}
      {renaming && (
        <FormDialog
          title="Renomear bot"
          size="sm"
          onClose={() => setRenaming(null)}
          onSubmit={async () => {
            await api(root + "/bots/" + renaming.id, "PATCH", { name });
            toast("Salvo com sucesso.");
            await app.refresh();
            setRenaming(null);
          }}
        >
          <Field
            label="Nome do bot"
            value={name}
            onChange={setName}
            maxLength={80}
            required
            help="É o nome que a equipe e o cliente veem (“Nome - IA”). Descobrir bots no Hermes não desfaz a troca."
          />
        </FormDialog>
      )}
    </>
  );
}
