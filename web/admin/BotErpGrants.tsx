// Tela do bot → o que ele pode fazer no ERP e as leituras que faz sozinho.
// O inventário (GET {root}/bots/erp-operations) é lido uma vez por área e
// serve a todos os cartões; as regras ficam em bot-erp-grants.ts.
import React, { useCallback, useEffect, useId, useState } from "react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { Confirm, Notice, Pill } from "../ui";
import {
  actionPatch,
  actionState,
  erpPermissionModules,
  type ErpBotAction,
  type ErpBotModule,
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
  /** As mesmas ações por módulo da tela de pessoa (vazio em servidor antigo). */
  modules?: ErpBotModule[] | null;
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
    modules: ErpBotModule[] | null;
    problem: ErpInventory["problem"];
  }>({ key: "", groups: null, modules: null, problem: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    if (!erpOn) {
      setState({ key, groups: null, modules: null, problem: inventoryProblem(null, false) });
      return;
    }
    let alive = true;
    api(root + "/bots/erp-operations").then(
      (data) => alive && setState({ key, groups: erpGroups(data), modules: erpPermissionModules(data), problem: null }),
      (error) => alive && setState({ key, groups: null, modules: null, problem: inventoryProblem(error, true) }),
    );
    return () => {
      alive = false;
    };
  }, [key, attempt, api]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const current = state.key === key;
  return {
    groups: current ? state.groups : null,
    modules: current ? state.modules : null,
    problem: current ? state.problem : null,
    reload,
  };
}

/**
 * Uma ação do módulo para o bot: liga todas as operações dela de uma vez; o
 * detalhe abre a lista de operações, que podem ser ligadas uma a uma.
 */
function ActionRow({
  action,
  operations,
  grants,
  disabled,
  onAction,
  onOperation,
}: {
  action: ErpBotAction;
  operations: ErpOperation[];
  grants: { operations: string[]; autonomous: string[] };
  disabled: boolean;
  onAction: (on: boolean) => void;
  onOperation: (op: ErpOperation, on: boolean) => void;
}) {
  const state = actionState(action, grants);
  const writes = operations.some((op) => operationKind(op).confirms);
  return (
    <div className="bot-erp-action">
      <label className="connection-row bot-erp-row">
        <input
          type="checkbox"
          checked={state === "all"}
          ref={(el) => {
            if (el) el.indeterminate = state === "some";
          }}
          disabled={disabled}
          aria-label={`Liberar ao bot: ${action.label}`}
          onChange={(event) => onAction(event.target.checked)}
        />
        <div>
          <strong>{action.label}</strong>{" "}
          {writes && <Pill tone="muted">pede confirmação</Pill>}
          <small>
            {action.description}
            {state === "some" && <span className="block">Só algumas operações liberadas (veja o detalhe).</span>}
          </small>
        </div>
      </label>
      <details className="bot-erp-detail">
        <summary>
          Detalhe: {operations.length} {operations.length === 1 ? "operação" : "operações"}
        </summary>
        {operations.map((op) => (
          <OperationRow
            key={op.id}
            op={op}
            checked={grants.operations.includes(op.id)}
            disabled={disabled}
            onToggle={(on) => onOperation(op, on)}
          />
        ))}
      </details>
    </div>
  );
}

type Pending =
  | { kind: "first"; op: { title: string }; patch: BotErpPatch }
  | { kind: "autonomous"; op: { title: string }; patch: BotErpPatch };

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
  const { groups, modules, problem } = inventory;
  const candidates = groups ? autonomousCandidates(groups, grants) : [];
  const byId = new Map((groups ?? []).flatMap((group) => group.operations.map((op) => [op.id, op] as const)));

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
            Tudo começa desligado. São as mesmas ações por módulo da tela de
            pessoa: o bot age com o acesso de quem pede e nunca faz o que essa
            pessoa não pode (vale o que os dois têm em comum). Para quem vem de
            fora, vale ainda o limite do cliente. Toda ação que muda algo ou lê
            dado sensível é proposta pelo bot e confirmada por uma pessoa.
          </p>
          {modules && modules.length > 0 && modules.map((mod) => (
            <details key={mod.module} className="bot-erp-group">
              <summary>
                {mod.title}{" "}
                <small>
                  ({mod.actions.filter((a) => actionState(a, grants) === "all").length} de {mod.actions.length}{" "}
                  {mod.actions.length === 1 ? "ação liberada" : "ações liberadas"})
                </small>
                {!mod.enabled && <small className="block">Módulo desligado: ligue em Gestão › Módulos para o bot usar.</small>}
              </summary>
              {mod.actions.map((action) => (
                <ActionRow
                  key={action.id}
                  action={action}
                  operations={action.operations.map((id) => byId.get(id)).filter((op): op is ErpOperation => !!op)}
                  grants={grants}
                  disabled={busy}
                  onAction={(on) => {
                    const patch = actionPatch(grants, action, on);
                    if (needsDataWarning(grants, on))
                      setPending({ kind: "first", op: { title: action.label }, patch });
                    else void send(patch);
                  }}
                  onOperation={(op, on) => {
                    const patch = operationPatch(grants, op.id, on);
                    if (needsDataWarning(grants, on))
                      setPending({ kind: "first", op, patch });
                    else void send(patch);
                  }}
                />
              ))}
            </details>
          ))}
          {!(modules && modules.length > 0) && groups
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
