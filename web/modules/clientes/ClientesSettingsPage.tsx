// Gestão → Cadastro e privacidade (módulo "clientes"): quem revela dados,
// texto e versão do aceite, campos obrigatórios do autocadastro, palavras
// de exclusão e de cadastro e o prazo de guarda fiscal (chave "clientes").
import React, { useState } from "react";
import { useApp } from "../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../app/hooks";
import type { Row } from "../../lib/api";
import { Card, Field, Pill, Button } from "../../ui";
import "./clientes.css";

/** Padrões do servidor (src/modules/clientes/model.ts). */
const defaults: Row = {
  reveal: "admin",
  consent_text:
    "Autorizo o uso destes dados para meu cadastro, emissão de notas fiscais e o meu atendimento. Posso corrigir ou pedir a exclusão a qualquer momento pelo WhatsApp.",
  terms_version: "1",
  require_document: true,
  require_address: false,
  erase_keywords: ["EXCLUIR MEUS DADOS", "APAGAR MEUS DADOS"],
  register_keywords: ["MEU CADASTRO"],
  fiscal_retention_years: 5,
};
const words = (value: string) =>
  value
    .split(/[,\n]/)
    .map((w) => w.trim())
    .filter(Boolean);

export function ClientesSettingsPage() {
  const app = useApp();
  const { busy, run } = useAction();
  const saved: Row = { ...defaults, ...(app.settings.clientes || {}) };
  const [draft, setDraft] = useState<Row>({
    ...saved,
    erase_keywords: saved.erase_keywords.join(", "),
    register_keywords: saved.register_keywords.join(", "),
  });
  const dirty =
    JSON.stringify({ ...draft, erase_keywords: words(draft.erase_keywords), register_keywords: words(draft.register_keywords) }) !==
    JSON.stringify(saved);
  useUnsavedGuard(dirty);
  const set = (key: string) => (value: any) => setDraft((current) => ({ ...current, [key]: value }));
  const menus: Row[] = app.settings.menus || [];
  const inMenu = (type: string) => menus.some((item) => item.type === type);
  return (
    <>
      <Card
        title="Como funciona"
        description="O cliente preenche e corrige o próprio cadastro por um link de uso único enviado no WhatsApp e dá o aceite. A equipe vê CPF, e-mail, telefones e endereço mascarados; ver sem máscara pede motivo e fica registrado. O cliente pode pedir a exclusão dos dados: ficam só as notas fiscais pelo prazo legal e os números dos atendimentos."
      >
        <p>
          <Pill tone={inMenu("clientes_cadastro") ? "ok" : "muted"}>
            {inMenu("clientes_cadastro") ? "Meu cadastro no menu" : "Meu cadastro fora do menu"}
          </Pill>{" "}
          <Pill tone={inMenu("clientes_exclusao") ? "ok" : "muted"}>
            {inMenu("clientes_exclusao") ? "Excluir meus dados no menu" : "Excluir meus dados fora do menu"}
          </Pill>
        </p>
        <small className="muted">Os itens entram em Menus e ações.</small>
      </Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              await app.api(app.root + "/settings", "PUT", {
                clientes: {
                  reveal: draft.reveal,
                  consent_text: draft.consent_text,
                  terms_version: draft.terms_version,
                  require_document: !!draft.require_document,
                  require_address: !!draft.require_address,
                  erase_keywords: words(draft.erase_keywords),
                  register_keywords: words(draft.register_keywords),
                  fiscal_retention_years: Number(draft.fiscal_retention_years),
                },
              });
              await app.refresh();
            },
            { success: "Regras salvas." },
          );
        }}
      >
        <Card title="Quem vê os dados sem máscara">
          <Field
            label="Pessoas da equipe"
            value={draft.reveal}
            onChange={set("reveal")}
            options={[
              ["admin", "Só administradores"],
              ["team", "Qualquer pessoa da área, com motivo"],
            ]}
            emptyOption={null}
            help="Integrações só com a permissão contacts:read. Toda revelação fica registrada em Clientes → Quem viu dados."
          />
        </Card>
        <Card title="Formulário do cliente">
          <Field
            label="Texto do aceite"
            type="textarea"
            rows={3}
            value={draft.consent_text}
            onChange={set("consent_text")}
            maxLength={1000}
            required
          />
          <div className="form-field-grid">
            <Field
              label="Versão do texto"
              value={draft.terms_version}
              onChange={set("terms_version")}
              maxLength={20}
              required
              help="Mude quando mudar o texto: o aceite guarda a versão."
            />
            <Field
              label="Guarda das notas fiscais (anos)"
              type="number"
              min={5}
              max={10}
              value={draft.fiscal_retention_years}
              onChange={set("fiscal_retention_years")}
              required
              help="Contados de 1º de janeiro do ano seguinte à emissão. O mínimo legal é 5."
            />
          </div>
          <label className="clientes-check">
            <input type="checkbox" checked={!!draft.require_document} onChange={(e) => set("require_document")(e.target.checked)} /> CPF ou CNPJ obrigatório
          </label>
          <label className="clientes-check">
            <input type="checkbox" checked={!!draft.require_address} onChange={(e) => set("require_address")(e.target.checked)} /> Endereço completo obrigatório (a NF-e exige)
          </label>
        </Card>
        <Card title="Palavras no WhatsApp">
          <div className="form-field-grid">
            <Field
              label="Pedir exclusão dos dados"
              value={draft.erase_keywords}
              onChange={set("erase_keywords")}
              help="Separe por vírgula. Valem em qualquer momento da conversa."
              required
            />
            <Field
              label="Receber o link do cadastro"
              value={draft.register_keywords}
              onChange={set("register_keywords")}
              help="Separe por vírgula. Pode ficar vazio."
            />
          </div>
        </Card>
        <div className="form-actions">
          <Button type="submit" busy={busy} disabled={!dirty}>
            Salvar regras
          </Button>
        </div>
      </form>
    </>
  );
}
