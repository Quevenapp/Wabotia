// Tela do bot → módulos de área (Saúde, Ensino, Jurídico, Condomínio): uma
// seção por módulo ligado na área, com as operações, os avisos e o registro.
// Tudo nasce desligado; ligar pede a confirmação do aviso do módulo. As
// regras ficam em bot-area-grants.ts e no servidor (src/bot-actions/area.ts).
import React, { useCallback, useEffect, useId, useState } from "react";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { whenLabel } from "../lib/format";
import { Confirm, Notice, Pill } from "../ui";
import {
  areaModules,
  areaProblem,
  enabledCount,
  grantRequest,
  logText,
  visibleModules,
  warningFor,
  type AreaGrantRequest,
  type AreaModule,
  type AreaOperation,
} from "./bot-area-grants";

type Pending = {
  module: AreaModule;
  kind: AreaGrantRequest["kind"];
  op?: AreaOperation;
};

const TITLES: Record<AreaGrantRequest["kind"], string> = {
  operation: "Liberar esta operação para o bot?",
  direct: "Deixar o bot fazer sem confirmação?",
  sensitive_fields: "Incluir campos sensíveis?",
};

function OperationRow({
  module,
  op,
  busy,
  toggle,
}: {
  module: AreaModule;
  op: AreaOperation;
  busy: boolean;
  toggle: (kind: AreaGrantRequest["kind"], on: boolean, op: AreaOperation) => void;
}) {
  const id = useId();
  return (
    <div className="connection-row bot-erp-row">
      <input
        type="checkbox"
        checked={op.enabled}
        disabled={busy}
        aria-label={`Liberar ao bot: ${op.title}`}
        aria-describedby={id}
        onChange={(event) => toggle("operation", event.target.checked, op)}
      />
      <div>
        <strong>{op.title}</strong>{" "}
        <Pill tone={op.kind === "write" ? "warn" : "muted"}>
          {op.kind === "write" ? "muda dados" : "só consulta"}
        </Pill>
        {op.kind === "write" && op.enabled && (
          <>
            {" "}
            <Pill tone={op.direct ? "warn" : "muted"}>
              {op.direct ? "faz sem confirmação" : "pede confirmação"}
            </Pill>
          </>
        )}
        <small id={id}>{op.description}</small>
        {op.kind === "write" && op.enabled && (
          <label className="block">
            <input
              type="checkbox"
              checked={op.direct}
              disabled={busy}
              aria-label={`Fazer sem a pessoa confirmar: ${op.title}`}
              onChange={(event) => toggle("direct", event.target.checked, op)}
            />{" "}
            <small>
              Fazer sem a pessoa confirmar (desligado: o bot propõe e a pessoa
              confirma, com o segundo fator).
            </small>
          </label>
        )}
      </div>
    </div>
  );
}

export function BotAreaGrants({ bot }: { bot: Row }) {
  const { api, root, moduleOn } = useApp();
  const [modules, setModules] = useState<AreaModule[] | null>(null);
  const [problem, setProblem] = useState<{ text: string; retry: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const key = [root, bot.id, ...["saude", "ensino", "juridico", "condominio"].map((id) => moduleOn(id))].join("|");
  useEffect(() => {
    let alive = true;
    setProblem(null);
    api(root + "/bots/" + bot.id + "/area-grants").then(
      (data) => alive && setModules(areaModules(data)),
      (failure) => alive && (setModules(null), setProblem(areaProblem(failure))),
    );
    return () => {
      alive = false;
    };
  }, [key, attempt, api]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  const send = async (module: AreaModule, kind: AreaGrantRequest["kind"], on: boolean, op?: AreaOperation) => {
    setBusy(true);
    setError("");
    try {
      const state = await api(root + "/bots/" + bot.id + "/area-grants", "PUT", grantRequest(module, kind, on, op?.id));
      const [fresh] = areaModules({ modules: [{ ...state, module_enabled: true }] });
      if (fresh) setModules((list) => list && list.map((m) => (m.module === fresh.module ? fresh : m)));
    } catch (failure: any) {
      setError(failure?.message || "Não deu para salvar agora. Tente de novo.");
      reload();
    } finally {
      setBusy(false);
    }
  };
  const toggle = (module: AreaModule) => (kind: AreaGrantRequest["kind"], on: boolean, op?: AreaOperation) => {
    if (on) setPending({ module, kind, op });
    else void send(module, kind, false, op);
  };

  const visible = modules ? visibleModules(modules) : [];
  return (
    <div className="bot-erp">
      <h3>Módulos de área: Saúde, Ensino, Jurídico e Condomínio</h3>
      {problem ? (
        problem.retry ? (
          <Notice tone="warn" onRetry={reload}>
            {problem.text}
          </Notice>
        ) : (
          <p className="workspace-help">{problem.text}</p>
        )
      ) : !modules ? (
        <p className="workspace-help">Carregando os módulos de área…</p>
      ) : !visible.length ? (
        <p className="workspace-help">
          Nenhum módulo de área ligado nesta área. Para liberar ao bot, ligue
          Saúde, Ensino, Jurídico ou Condomínio em Gestão › Módulos.
        </p>
      ) : (
        <>
          <p className="workspace-help">
            Tudo começa desligado e cada operação é liberada por você, com um
            aviso. O bot age com o acesso de quem pede, só na conversa da
            equipe pelo app; cliente no WhatsApp nunca usa estas operações.
          </p>
          {error && <Notice tone="warn">{error}</Notice>}
          {visible.map((module) => (
            <details key={module.module} className="bot-erp-group">
              <summary>
                {module.title}{" "}
                <small>
                  ({enabledCount(module) ? `${enabledCount(module)} liberada(s)` : "nada liberado"})
                </small>
              </summary>
              <p className="workspace-help">{module.warning}</p>
              <label className="connection-row bot-erp-row">
                <input
                  type="checkbox"
                  checked={module.sensitive_fields}
                  disabled={busy}
                  aria-label={`Incluir campos sensíveis: ${module.title}`}
                  onChange={(event) => toggle(module)("sensitive_fields", event.target.checked)}
                />
                <div>
                  <strong>Incluir campos sensíveis</strong>{" "}
                  <Pill tone={module.sensitive_fields ? "warn" : "muted"}>
                    {module.sensitive_fields ? "ligado" : "desligado"}
                  </Pill>
                  <small>
                    {module.sensitive_fields
                      ? `O bot recebe ${module.sensitive_label} nas operações liberadas.`
                      : `Desligado: mesmo com a operação liberada, ${module.sensitive_label} não vão ao bot.`}
                  </small>
                </div>
              </label>
              {module.operations.map((op) => (
                <OperationRow key={op.id} module={module} op={op} busy={busy} toggle={toggle(module)} />
              ))}
              <h4>Registro</h4>
              {module.log.length ? (
                <ul className="workspace-help">
                  {module.log.map((entry) => (
                    <li key={entry.id}>
                      {whenLabel(entry.created)} — {logText(entry)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="workspace-help">Nada ligado, desligado ou usado ainda.</p>
              )}
            </details>
          ))}
        </>
      )}
      {pending && (
        <Confirm
          title={TITLES[pending.kind]}
          confirmLabel="Entendi, liberar"
          danger
          busy={busy}
          onClose={() => setPending(null)}
          onConfirm={() => {
            const { module, kind, op } = pending;
            setPending(null);
            void send(module, kind, true, op);
          }}
        >
          <p>
            <strong>
              {pending.module.title}
              {pending.op ? ` › ${pending.op.title}` : ""}
            </strong>
          </p>
          <p>{warningFor(pending.module, pending.kind)}</p>
          <p>
            Fica registrado quem liberou, quando e para qual bot ({bot.name}).
            Você pode desligar quando quiser.
          </p>
        </Confirm>
      )}
    </div>
  );
}
