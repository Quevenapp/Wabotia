// Atendente e especialistas: bots internos, linhas de cada bot e as ações
// internas que o Atendente pode pedir a um especialista.
import React, { useEffect, useState } from "react";
import { ArrowRight, Bot, Check, Plus } from "lucide-react";
import { useApp } from "../app/AppContext";
import { useAction } from "../app/hooks";
import type { Row } from "../lib/api";
import { Badge, Button, CopyButton, Empty, Field, toast } from "../ui";
import { BotLinesEditor } from "../ServicePanels";
import { linkProps } from "../lib/routes";
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
        label="Especialista"
        value={form.bot_id}
        onChange={change("bot_id")}
        options={app.bots.filter((bot) => bot.connection_kind === "ai")}
        help="Bot interno: só consulta os dados do cliente da conversa (ferramentas de leitura dos módulos ligados) e não muda nada."
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
  const { api, root, demo, settings } = app;
  const bots = app.bots.filter((bot) => bot.connection_kind === "ai");
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false),
    [renaming, setRenaming] = useState<Row | null>(null),
    [name, setName] = useState("");
  useEffect(() => setName(renaming?.name || ""), [renaming?.id]);
  const save = (fn: () => Promise<any>) =>
    run(fn, { success: "Salvo com sucesso." }).then(() => app.refresh());
  const enabledBot = bots.find((bot) => bot.enabled);
  return (
    <>
      <section className="card">
        <h2>Comece aqui: o bot para a equipe</h2>
        <p className="workspace-help">
          Além de atender clientes no WhatsApp, cada bot conversa com a equipe em{" "}
          <strong>Equipe › Bots</strong>: consulta o Wabotia e propõe ações em nome
          de quem pede, com o acesso dessa pessoa. Nada muda antes de ela tocar
          em Confirmar.
        </p>
        <ol className="workspace-help">
          <li>
            {bots.length ? (
              "Conexão feita."
            ) : (
              <>
                Conecte um provedor de IA em{" "}
                <a {...linkProps({ area: "admin", page: "connections" })}>
                  Conexões
                </a>{" "}
                e use Testar conexão: o bot aparece aqui.
              </>
            )}
          </li>
          <li>
            {enabledBot
              ? `Bot ligado: ${enabledBot.name}.`
              : `Habilite o bot ${bots.length ? "abaixo" : "nesta tela"}. Ele nasce desligado, para não começar a responder sem você decidir.`}
          </li>
          <li>
            Converse com ele em{" "}
            <a {...linkProps({ area: "team", sub: "bots" })}>Equipe › Bots</a>.
          </li>
        </ol>
      </section>
      <section className="card">
        <h2>O Atendente conversa. Os especialistas executam.</h2>
        <p className="workspace-help">
          Escolha um bot principal para receber o cliente. Em uma ação interna,
          ele consulta outro bot e recebe o resultado para responder. Por
          exemplo: um especialista interno consulta os dados do cliente da
          conversa nos módulos ligados e devolve o resultado ao Atendente.
        </p>
        <div className="service-flow">
          <span>Bot Atendente</span>
          <ArrowRight size={16} />
          <span>Especialista</span>
          <ArrowRight size={16} />
          <span>API do sistema</span>
        </div>
      </section>
      <div className="toolbar">
        <p>
          Selecione os bots internos conectados a um provedor de IA.
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
                ? `Provedor de IA: ${bot.model || bot.provider || ""}. ${
                    bot.tools_unsupported
                      ? "O provedor recusou as ferramentas: só conversa. Troque o modelo ou o provedor em Conexões."
                      : "Atende clientes com as ferramentas dos módulos e, na Equipe, consulta e propõe ações em nome de quem pede."
                  }`
                : "Bot indisponível"}
            </p>
            {!bot.enabled && (
              <p className="workspace-help">
                Desligado: não atende nem conversa na Equipe até ser habilitado.
              </p>
            )}
            {app.isAdmin && (
              <label className="workspace-help">
                <input
                  type="checkbox"
                  checked={bot.mask_personal !== false}
                  disabled={busy}
                  onChange={(event) => {
                    const mask_personal = event.target.checked;
                    save(() => api(root + "/bots/" + bot.id, "PATCH", { mask_personal }));
                  }}
                />{" "}
                Mascarar documentos e telefones nas mensagens antes de enviar à IA
                <small className="block">
                  Inclui e-mail, CEP, histórico, consultas ao JEV e texto de PDF. Fotos e imagens vão ao provedor como estão: um
                  documento fotografado não é mascarado. Com a opção ligada, PDF que não dá para ler como texto vai para a equipe.
                </small>
              </label>
            )}
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
            title="Sua Equipe Bot começa em Conexões"
            description="Conecte um provedor de IA e use Testar conexão."
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
            help="É o nome que a equipe e o cliente veem (“Nome - IA”)."
          />
        </FormDialog>
      )}
    </>
  );
}
