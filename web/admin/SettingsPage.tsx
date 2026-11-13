// Regras de atendimento: orientações, ausência da equipe, avaliações, JEV,
// o bloco Protocolos e o estado (ativo/pausado) do atendimento.
import React, { useMemo, useState } from "react";
import { useApp } from "../app/AppContext";
import { useAction, useUnsavedGuard } from "../app/hooks";
import type { Row } from "../lib/api";
import { navigate } from "../lib/routes";
import { Button, Field, Notice, toast } from "../ui";
import { ProtocolSettings, protocolProblems } from "./ProtocolSettings";
import { FormDialog } from "./shared";

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function JevDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [key, setKey] = useState("");
  return (
    <FormDialog
      title="Chave JEV"
      onClose={onClose}
      onSubmit={async () => {
        await app.api(app.root + "/jev", "POST", { key });
        toast("Salvo com sucesso.");
        onClose();
      }}
    >
      <p>
        A chave será guardada de forma protegida. Depois de salvar, ligue ou
        desligue o JEV nas regras de atendimento.
      </p>
      <Field
        label="Chave da API JEV"
        type="password"
        value={key}
        onChange={setKey}
        autoComplete="off"
        required
      />
    </FormDialog>
  );
}

export function SettingsPage() {
  const app = useApp();
  const { api, root, status } = app;
  // Só as chaves alteradas são enviadas; o restante acompanha o servidor.
  const [changes, setChanges] = useState<Row>({});
  const [jev, setJev] = useState(false);
  const { busy, run } = useAction();
  const dirty = Object.keys(changes).length > 0;
  useUnsavedGuard(dirty);
  const settings = useMemo(
    () => ({ ...app.settings, ...changes }),
    [app.settings, changes],
  );
  const edit = (patch: Row) =>
    setChanges((current) => {
      const next = { ...current, ...patch };
      // Voltar ao valor salvo deixa de contar como alteração.
      for (const key of Object.keys(patch))
        if (same(next[key], app.settings[key])) delete next[key];
      return next;
    });
  const problems = protocolProblems(settings);

  async function save() {
    const patch = { ...changes };
    const saved = await run(() => api(root + "/settings", "PUT", patch), {
      success: "Regras salvas.",
      retry: false,
    });
    if (!saved) return;
    setChanges((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch))
        if (same(next[key], patch[key])) delete next[key];
      return next;
    });
    await app.refresh().catch(() => {});
  }

  return (
    <div className="settings-layout">
      <div className="settings-main">
        <section className="card">
          <h2>Como sua equipe atende</h2>
          <Field
            label="Orientações para o Bot Atendente"
            type="textarea"
            value={settings.instructions}
            onChange={(value) => edit({ instructions: value })}
          />
          <Field
            label="Orientação quando não há humanos presentes"
            type="textarea"
            value={settings.absence_instructions}
            onChange={(value) => edit({ absence_instructions: value })}
            help="Enviada antes da confirmação do protocolo aberto na ausência da equipe."
          />
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.absence_ticket !== false}
              onChange={(event) =>
                edit({ absence_ticket: event.target.checked })
              }
            />
            Abrir protocolo quando a equipe está ausente
          </label>
          <p className="workspace-help">
            Desligado: ao encaminhar uma conversa sem ninguém presente, o
            cliente só é avisado de que a equipe está ausente; nenhum protocolo
            é aberto e a orientação acima não é enviada.
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.absence_followup !== false}
              onChange={(event) =>
                edit({ absence_followup: event.target.checked })
              }
            />
            Bot Atendente continua respondendo enquanto a equipe está ausente
          </label>
          <p className="workspace-help">
            Ligado: se o cliente escreve depois de encaminhado e não há ninguém
            presente, o bot responde com o que já foi informado (protocolo e
            prazo), sem tirar a conversa da fila da equipe.
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.protocol_consent_prompt !== false}
              onChange={(event) =>
                edit({ protocol_consent_prompt: event.target.checked })
              }
            />
            Pedir autorização de notificações ao abrir protocolo
          </label>
          <p className="workspace-help">
            Enviado uma vez por conversa, com os botões Autorizo e Não autorizo,
            somente quando as notificações de protocolo estão ligadas.
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={settings.sender_signature !== false}
              onChange={(event) =>
                edit({ sender_signature: event.target.checked })
              }
            />
            Identificar quem escreve nas mensagens ao cliente
          </label>
          <p className="workspace-help">
            Cada mensagem de uma pessoa ou de um bot começa com o nome e o tipo,
            por exemplo <strong>Bruno - Humano</strong> ou{" "}
            <strong>Bia - IA</strong>. O nome da pessoa vem de Pessoas e
            acessos; o do bot, da Equipe Bot. Menus, botões e avisos
            automáticos não levam assinatura.
          </p>
          <label className="check-field">
            <input
              type="checkbox"
              checked={!!settings.surveys_enabled}
              onChange={(event) =>
                edit({ surveys_enabled: event.target.checked })
              }
            />
            Pedir avaliação ao concluir
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={!!settings.jev_enabled}
              onChange={(event) => edit({ jev_enabled: event.target.checked })}
            />
            Usar JEV na tomada de decisão
          </label>
          <p className="workspace-help">
            Desligado: o Bot Atendente decide os encaminhamentos. Ligado: o
            Atendente interpreta a solicitação e propõe uma ação; o JEV decide
            se ela pode seguir, se é preciso esclarecer ou encaminhar para uma
            pessoa. Se a decisão falhar ou for incerta, o atendimento vai para a
            equipe humana.
          </p>
          <button
            type="button"
            className="text-link block"
            onClick={() => setJev(true)}
          >
            Cadastrar ou substituir chave JEV
          </button>
        </section>
        <ProtocolSettings values={settings} edit={edit} />
        <div className={"save-bar" + (dirty ? " dirty" : "")}>
          <div role="status">
            {dirty
              ? problems[0] || "Há alterações ainda não salvas."
              : "Tudo salvo."}
          </div>
          {dirty && (
            <Button secondary disabled={busy} onClick={() => setChanges({})}>
              Descartar
            </Button>
          )}
          <Button
            busy={busy}
            disabled={!dirty || problems.length > 0}
            onClick={() => void save()}
          >
            {busy ? "Salvando…" : "Salvar regras"}
          </Button>
        </div>
      </div>
      <aside className="settings-side">
        <div className="card">
          <h2>Estado do atendimento</h2>
          <p>Confira bots, canais e conhecimento antes de ativar.</p>
          <p className="settings-state">
            <span
              className={
                "presence-dot " + (status.enabled ? "online" : "offline")
              }
              style={{ width: 10, height: 10 }}
            />
            {status.enabled ? "Atendimento ativo" : "Atendimento pausado"}
          </p>
          <Button
            disabled={busy || dirty}
            onClick={() =>
              run(
                () =>
                  api(
                    root + (status.enabled ? "/pause" : "/activate"),
                    "POST",
                    {},
                  ),
                { success: "Salvo com sucesso." },
              ).then(() => app.refresh())
            }
          >
            {status.enabled ? "Pausar atendimento" : "Ativar atendimento"}
          </Button>
          {dirty && (
            <p className="workspace-help">
              Salve ou descarte as alterações antes de mudar o estado.
            </p>
          )}
        </div>
        <div className="card">
          <h2>Precisa de orientação?</h2>
          <p>
            O assistente ajuda a conectar os serviços e conferir cada parte
            antes de ativar o atendimento.
          </p>
          <Button
            secondary
            onClick={() => navigate({ area: "admin", page: "setup" })}
          >
            Abrir configuração guiada
          </Button>
        </div>
        {problems.length > 0 && dirty && (
          <Notice tone="warn">
            {problems.map((problem) => (
              <span key={problem} className="block-line">
                {problem}
              </span>
            ))}
          </Notice>
        )}
      </aside>
    </div>
  );
}
