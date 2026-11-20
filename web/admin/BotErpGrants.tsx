// Tela do bot → o que ele pode fazer no ERP e as leituras que faz sozinho.
// O inventário (GET {root}/bots/erp-operations) é lido uma vez por área e
// serve a todos os cartões; as regras ficam em bot-erp-grants.ts.
import React, { useCallback, useEffect, useId, useState } from "react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { Confirm, Notice, Pill } from "../ui";
import {
  autonomousCandidates,
  autonomousPatch,
  botErpGrants,
  erpGroups,
  groupCount,
  groupCountText,
  inventoryProblem,
  missingModulesText,
  needsDataWarning,
  operationKind,
  operationPatch,
  type BotErpPatch,
  type ErpOperation,
  type ErpOperationGroup,
} from "./bot-erp-grants";

export type ErpInventory = {
  groups: ErpOperationGroup[] | null;
  problem: { text: string; retry: boolean } | null;
  reload: () => void;
};

/** Inventário da área atual; relido ao trocar de área ou ligar o ERP. */
export function useErpOperations(enabled: boolean): ErpInventory {
  const { api, root, moduleOn } = useApp();
  const erpOn = moduleOn("erp");
  const key = enabled ? root + "|" + erpOn : "";
  const [state, setState] = useState<{
    key: string;
    groups: ErpOperationGroup[] | null;
    problem: ErpInventory["problem"];
  }>({ key: "", groups: null, problem: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    if (!erpOn) {
      setState({ key, groups: null, problem: inventoryProblem(null, false) });
      return;
    }
    let alive = true;
    api(root + "/bots/erp-operations").then(
      (data) => alive && setState({ key, groups: erpGroups(data), problem: null }),
      (error) => alive && setState({ key, groups: null, problem: inventoryProblem(error, true) }),
    );
    return () => {
      alive = false;
    };
  }, [key, attempt, api]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = state.key === key;
  return {
    groups: current ? state.groups : null,
    problem: current ? state.problem : null,
    reload,
  };
}

type Pending =
  | { kind: "first"; op: ErpOperation; patch: BotErpPatch }
  | { kind: "autonomous"; op: ErpOperation; patch: BotErpPatch };

function OperationRow({
  op,
  checked,
  disabled,
  onToggle,
}: {
  op: ErpOperation;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const id = useId();
  const kind = operationKind(op);
  const missing = missingModulesText(op);
  return (
    <label className="connection-row bot-erp-row">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={`Liberar ao bot: ${op.title}`}
        aria-describedby={id}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <div>
        <strong>{op.title}</strong>{" "}
        <Pill tone={op.kind === "write" ? "warn" : "muted"}>{kind.label}</Pill>
        {kind.confirms && (
          <>
            {" "}
            <Pill tone="muted">pede confirmação</Pill>
          </>
        )}
        <small id={id}>
          {op.description}
          {missing && (
            <span className="block">
              {missing} Enquanto essa parte estiver desligada, o bot não usa
              esta operação.
            </span>
          )}
        </small>
      </div>
    </label>
  );
}

export function BotErpGrants({
  bot,
  inventory,
  busy,
  save,
}: {
  bot: Row;
  inventory: ErpInventory;
  busy: boolean;
  save: (fn: () => Promise<any>) => Promise<unknown>;
}) {
  const { api, root } = useApp();
  const [pending, setPending] = useState<Pending | null>(null);
  const grants = botErpGrants(bot);
  const send = (patch: BotErpPatch) =>
    save(() => api(root + "/bots/" + bot.id, "PATCH", patch));
  const { groups, problem } = inventory;
  const candidates = groups ? autonomousCandidates(groups, grants) : [];

  return (
    <div className="bot-erp">
      <h3>O que este bot pode fazer no ERP</h3>
      {problem ? (
        problem.retry ? (
          <Notice tone="warn" onRetry={inventory.reload}>
            {problem.text}
          </Notice>
        ) : (
          <p className="workspace-help">{problem.text}</p>
        )
      ) : !groups ? (
        <p className="workspace-help">Carregando as operações do ERP…</p>
      ) : !groups.some((group) => group.operations.length) ? (
        <p className="workspace-help">
          Nenhuma operação do ERP disponível nesta área.
        </p>
      ) : (
        <>
          <p className="workspace-help">
            Tudo começa desligado. O bot age com o acesso de quem pede, e toda
            ação pede confirmação da pessoa antes de mudar algo.
          </p>
          {groups
            .filter((group) => group.operations.length)
            .map((group) => (
              <details key={group.id} className="bot-erp-group">
                <summary>
                  {group.title}{" "}
                  <small>({groupCountText(groupCount(group, grants))})</small>
                </summary>
                {group.operations.map((op) => (
                  <OperationRow
                    key={op.id}
                    op={op}
                    checked={grants.operations.includes(op.id)}
                    disabled={busy}
                    onToggle={(on) => {
                      const patch = operationPatch(grants, op.id, on);
                      if (needsDataWarning(grants, on))
                        setPending({ kind: "first", op, patch });
                      else void send(patch);
                    }}
                  />
                ))}
              </details>
            ))}
          <h3>Leituras que o bot pode fazer sozinho</h3>
          <p className="workspace-help">
            Desligada, o bot propõe a consulta e a pessoa confirma. Ligada, o
            bot lê sem pedir confirmação.
          </p>
          {candidates.length ? (
            candidates.map((op) => (
              <label key={op.id} className="connection-row bot-erp-row">
                <input
                  type="checkbox"
                  checked={grants.autonomous.includes(op.id)}
                  disabled={busy}
                  aria-label={`Ler sem pedir confirmação: ${op.title}`}
                  onChange={(event) => {
                    const on = event.target.checked;
                    const patch = autonomousPatch(grants, op.id, on);
                    if (on) setPending({ kind: "autonomous", op, patch });
                    else void send(patch);
                  }}
                />
                <div>
                  <strong>{op.title}</strong>
                  <small>
                    {grants.autonomous.includes(op.id)
                      ? "Ligada: o bot lê sem pedir confirmação."
                      : "Desligada: o bot propõe a consulta e a pessoa confirma."}
                  </small>
                </div>
              </label>
            ))
          ) : (
            <p className="workspace-help">
              Aparecem aqui as leituras sensíveis liberadas acima (por exemplo,
              dados financeiros). Libere uma delas para escolher se o bot pode
              lê-la sem pedir confirmação.
            </p>
          )}
        </>
      )}
      {pending && (
        <Confirm
          title={
            pending.kind === "first"
              ? "Liberar o ERP para este bot?"
              : "Ler sem pedir confirmação?"
          }
          confirmLabel="Liberar"
          busy={busy}
          onClose={() => setPending(null)}
          onConfirm={() => {
            const { patch } = pending;
            setPending(null);
            void send(patch);
          }}
        >
          {pending.kind === "first" ? (
            <>
              <p>
                Os dados do ERP usados em <strong>{pending.op.title}</strong> e
                nas próximas operações que você liberar passarão ao provedor de
                IA deste bot ({bot.model || bot.provider || bot.name}).
              </p>
              <p>
                Nas consultas, documentos e telefones vão mascarados, salvo se
                a instalação liberar dados pessoais completos ao bot. O bot age
                com o acesso de quem pede, e toda ação pede a confirmação da
                pessoa antes de mudar algo.
              </p>
            </>
          ) : (
            <p>
              Com isto ligado, o bot faz <strong>{pending.op.title}</strong> sem
              a pessoa confirmar, e esses dados sensíveis vão ao provedor de IA
              na hora.
            </p>
          )}
        </Confirm>
      )}
    </div>
  );
}
