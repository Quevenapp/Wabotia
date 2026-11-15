// Gestão → Regras do suporte (módulo "suporte"): setor de destino, modo de
// identificação, pacotes avulsos, planos oferecidos, formas de pagamento,
// carência (da Mensalidade), textos e o item do menu do WhatsApp.
import React, { useState } from "react";
import { Check, Plus, Trash2 } from "lucide-react";
import { useApp } from "../../app/AppContext";
import { useAction, useUnsavedGuard } from "../../app/hooks";
import type { Row } from "../../lib/api";
import { Button, Card, Field, Notice, Pill } from "../../ui";
import { useResource } from "../../admin/shared";
import { cents, money } from "./shared";
import "../mensalidade/mensalidade.css";

const defaults: Row = {
  department_id: null,
  identify: "any",
  max_attempts: 3,
  packages: [],
  offer_plans: true,
  plan_ids: [],
  methods: ["pix", "link"],
  texts: {
    offer:
      "O atendimento humano é para clientes com suporte contratado. Escolha uma opção para continuar:",
    released: "Tudo certo! Vamos chamar um atendente para você.",
  },
};

type PackageDraft = {
  id: string;
  name: string;
  price: string;
  mode: string;
  hours: string;
  active: boolean;
};

export function SuporteSettingsPage() {
  const app = useApp();
  const { busy, run } = useAction();
  const saved: Row = {
    ...defaults,
    ...(app.settings.suporte || {}),
    texts: { ...defaults.texts, ...(app.settings.suporte?.texts || {}) },
  };
  const [draft, setDraft] = useState<Row>(saved);
  const [packages, setPackages] = useState<PackageDraft[]>(() =>
    (saved.packages || []).map((p: Row) => ({
      id: p.id,
      name: p.name,
      price: (p.price_cents / 100).toFixed(2).replace(".", ","),
      mode: p.mode,
      hours: String(p.hours || ""),
      active: p.active !== false,
    })),
  );
  const grace = app.settings.mensalidade?.grace_days ?? 0;
  const [graceDays, setGraceDays] = useState(String(grace));
  const mensalidadeOn = app.moduleOn("mensalidade");
  const plans = useResource(
    mensalidadeOn ? `${app.root}/mensalidade/plans` : null,
  );
  const sellable: Row[] = (plans.data?.data || []).filter(
    (p: Row) => p.active && p.sellable,
  );
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(saved) ||
    JSON.stringify(packages) !==
      JSON.stringify(
        (saved.packages || []).map((p: Row) => ({
          id: p.id,
          name: p.name,
          price: (p.price_cents / 100).toFixed(2).replace(".", ","),
          mode: p.mode,
          hours: String(p.hours || ""),
          active: p.active !== false,
        })),
      ) ||
    graceDays !== String(grace);
  useUnsavedGuard(dirty);
  const set = (key: string) => (value: any) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setText = (key: string) => (value: string) =>
    setDraft((current) => ({
      ...current,
      texts: { ...current.texts, [key]: value },
    }));
  const setPackage = (index: number, key: keyof PackageDraft) => (value: any) =>
    setPackages(
      packages.map((p, i) => (i === index ? { ...p, [key]: value } : p)),
    );
  const menus: Row[] = app.settings.menus || [];
  const inMenu = menus.some((item) => item.type === "suporte_humano");
  const departments: Row[] = (app.settings.departments || []).filter(
    (d: Row) => d.enabled !== false,
  );
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((item) => item !== value);
  return (
    <>
      <Card
        title="Como funciona"
        description="No menu, o cliente escolhe Atendimento humano (pago). O Wabotia reconhece o pagador pelo telefone autorizado ou pede o CPF/CNPJ, confere a mensalidade e passa para a equipe quem está em dia. Em atraso, o cliente paga a parcela ali mesmo; sem assinatura, compra suporte avulso ou contrata um plano mensal. Só o pagamento confirmado pelo Mercado Pago libera."
      />
      <Card
        title="Menu do WhatsApp"
        description='Exemplo: um submenu "Falar com atendente" com "Falar com a IA (grátis)" (item de bot) e "Atendimento humano (pago)" (este módulo). Monte em Menus e ações.'
      >
        <Pill tone={inMenu ? "ok" : "muted"}>
          {inMenu ? "No menu" : "Fora do menu"}
        </Pill>
      </Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(
            async () => {
              const pkgs = packages.map((p, index) => {
                const price = cents(p.price);
                if (price === null)
                  throw new Error(
                    `Preço do pacote ${index + 1} inválido. Use, por exemplo, 49,00.`,
                  );
                return {
                  id: p.id || `pacote-${index + 1}`,
                  name: p.name,
                  price_cents: price,
                  mode: p.mode,
                  ...(p.mode === "hours" ? { hours: Number(p.hours) } : {}),
                  active: p.active,
                };
              });
              await app.api(app.root + "/settings", "PUT", {
                suporte: {
                  department_id: draft.department_id || null,
                  identify: draft.identify,
                  max_attempts: Number(draft.max_attempts),
                  packages: pkgs,
                  offer_plans: !!draft.offer_plans,
                  plan_ids: draft.plan_ids || [],
                  methods: draft.methods,
                  texts: draft.texts,
                },
                ...(mensalidadeOn
                  ? {
                      mensalidade: {
                        ...(app.settings.mensalidade || {}),
                        grace_days: Number(graceDays) || 0,
                      },
                    }
                  : {}),
              });
              await app.refresh();
            },
            { success: "Regras salvas." },
          );
        }}
      >
        <Card title="Para quem vai a conversa liberada">
          <div className="form-field-grid">
            <Field
              label="Setor de destino"
              value={draft.department_id || ""}
              onChange={set("department_id")}
              options={departments.map((d) => ({ id: d.id, name: d.name }))}
              emptyOption="Equipe geral"
            />
            <Field
              label="Identificação"
              value={draft.identify}
              onChange={set("identify")}
              emptyOption={null}
              options={[
                {
                  id: "any",
                  name: "CPF/CNPJ libera, com aviso se o telefone não for vinculado",
                },
                {
                  id: "linked_only",
                  name: "Só telefone vinculado (os demais a equipe confirma)",
                },
              ]}
            />
            <Field
              label="Tentativas de CPF/CNPJ"
              type="number"
              min={1}
              max={5}
              value={draft.max_attempts}
              onChange={set("max_attempts")}
              required
            />
            {mensalidadeOn && (
              <Field
                label="Carência (dias após o vencimento)"
                type="number"
                min={0}
                max={60}
                value={graceDays}
                onChange={setGraceDays}
                help="Regra da Mensalidade: nesse prazo o pagador ainda conta como em dia."
              />
            )}
          </div>
        </Card>
        <Card
          title="Suporte avulso"
          description="Pacotes vendidos para quem não tem assinatura. Validade: até o protocolo fechar ou por horas."
        >
          {packages.map((p, index) => (
            <fieldset className="form-field-editor" key={index}>
              <legend>Pacote {index + 1}</legend>
              <div className="form-field-grid">
                <Field
                  label="Nome (até 40)"
                  value={p.name}
                  onChange={setPackage(index, "name")}
                  maxLength={40}
                  required
                />
                <Field
                  label="Preço (R$)"
                  value={p.price}
                  onChange={setPackage(index, "price")}
                  placeholder="49,00"
                  required
                />
                <Field
                  label="Validade"
                  value={p.mode}
                  onChange={setPackage(index, "mode")}
                  emptyOption={null}
                  options={[
                    { id: "ticket", name: "Até o protocolo fechar" },
                    { id: "hours", name: "Por horas" },
                  ]}
                />
                {p.mode === "hours" && (
                  <Field
                    label="Horas"
                    type="number"
                    min={1}
                    max={720}
                    value={p.hours}
                    onChange={setPackage(index, "hours")}
                    required
                  />
                )}
              </div>
              <div className="form-field-actions">
                <label className="mensalidade-check">
                  <input
                    type="checkbox"
                    checked={p.active}
                    onChange={(e) =>
                      setPackage(index, "active")(e.target.checked)
                    }
                  />{" "}
                  Oferecer
                </label>
                <span className="spacer" />
                <button
                  type="button"
                  className="icon-button sm"
                  aria-label={`Remover pacote ${index + 1}`}
                  onClick={() =>
                    setPackages(packages.filter((_, i) => i !== index))
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </fieldset>
          ))}
          {packages.length < 9 && (
            <Button
              secondary
              icon={<Plus size={16} />}
              onClick={() =>
                setPackages([
                  ...packages,
                  {
                    id: `pacote-${crypto.randomUUID().slice(0, 6)}`,
                    name: "",
                    price: "",
                    mode: "ticket",
                    hours: "",
                    active: true,
                  },
                ])
              }
            >
              Adicionar pacote
            </Button>
          )}
        </Card>
        <Card
          title="Plano mensal"
          description="Planos marcados como vendáveis em Mensalidades → Planos e regras."
        >
          {!mensalidadeOn ? (
            <Notice>
              Ligue o módulo Mensalidade para oferecer planos mensais.
            </Notice>
          ) : (
            <>
              <label className="mensalidade-check">
                <input
                  type="checkbox"
                  checked={!!draft.offer_plans}
                  onChange={(e) => set("offer_plans")(e.target.checked)}
                />{" "}
                Oferecer planos mensais
              </label>
              {draft.offer_plans &&
                (sellable.length ? (
                  sellable.map((p) => (
                    <label className="mensalidade-check" key={p.id}>
                      <input
                        type="checkbox"
                        checked={
                          !draft.plan_ids?.length ||
                          draft.plan_ids.includes(p.id)
                        }
                        onChange={(e) =>
                          set("plan_ids")(
                            toggle(
                              draft.plan_ids?.length
                                ? draft.plan_ids
                                : sellable.map((x) => x.id),
                              p.id,
                              e.target.checked,
                            ),
                          )
                        }
                      />{" "}
                      {p.name} · {money(p.amount_cents)}
                    </label>
                  ))
                ) : (
                  <p className="muted">Nenhum plano vendável ainda.</p>
                ))}
            </>
          )}
        </Card>
        <Card
          title="Formas de pagamento"
          description="Pela Cobrança (Mercado Pago). Só o pagamento confirmado pelo provedor libera."
        >
          {(["pix", "link"] as const).map((m) => (
            <label className="mensalidade-check" key={m}>
              <input
                type="checkbox"
                checked={draft.methods.includes(m)}
                onChange={(e) => {
                  const next = toggle(draft.methods, m, e.target.checked);
                  if (next.length) set("methods")(next);
                }}
              />{" "}
              {m === "pix"
                ? "Pix copia e cola na conversa"
                : "Link de pagamento (cartão, Pix…)"}
            </label>
          ))}
        </Card>
        <Card title="Textos">
          <Field
            label="Antes das opções de compra"
            type="textarea"
            rows={2}
            value={draft.texts.offer}
            onChange={setText("offer")}
            maxLength={600}
          />
          <Field
            label="Ao liberar"
            type="textarea"
            rows={2}
            value={draft.texts.released}
            onChange={setText("released")}
            maxLength={600}
          />
        </Card>
        <div className="toolbar">
          <span />
          <Button
            type="submit"
            busy={busy}
            disabled={!dirty}
            icon={<Check size={17} />}
          >
            Salvar regras
          </Button>
        </div>
      </form>
    </>
  );
}
