import React, { useEffect, useState } from "react";
import {
  numberPolicy,
  numberPolicyPresets,
  numberPurposeLabels,
  type NumberPolicy,
  type NumberPolicyFlag,
  type NumberPurpose,
} from "../src/number-policy";

const options: [NumberPolicyFlag, string, string][] = [
  [
    "service",
    "Respostas dentro de 24 horas",
    "Mensagens de serviço no número que recebeu contato do cliente nas últimas 24 horas.",
  ],
  [
    "templates",
    "Templates aprovados",
    "Permite templates aprovados, com consentimento e autorização para eventuais cobranças em cada envio.",
  ],
  [
    "human",
    "Atendimento manual",
    "Atendentes podem assumir e responder pelo painel ou pelos aplicativos.",
  ],
  [
    "api",
    "Envios por programas externos",
    "Somente aplicações e origens que o administrador já autorizou.",
  ],
  [
    "menu",
    "Menus e submenus",
    "Permite menus nas linhas e nos momentos escolhidos no painel de menus.",
  ],
  [
    "bots",
    "Atendimento pelos bots Hermes",
    "Permite o Atendente e os especialistas autorizados na área de atendimento.",
  ],
  [
    "pool",
    "Participar de grupos de roteamento",
    "Pode ser selecionado pelos grupos em que estiver cadastrado.",
  ],
];

export function NumberPolicyEditor({
  policy,
  name,
  busy,
  onSave,
}: {
  policy?: NumberPolicy;
  name: string;
  busy: boolean;
  onSave: (value: NumberPolicy) => Promise<any>;
}) {
  const saved = JSON.stringify(numberPolicy({ number_policy: policy }));
  const [draft, setDraft] = useState<NumberPolicy>(() => JSON.parse(saved));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(JSON.parse(saved));
  }, [saved, dirty]);
  return (
    <details className="number-policy-editor">
      <summary>
        Função e permissões · {numberPurposeLabels[policy?.purpose || "custom"]}
      </summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onSave(draft)) setDirty(false);
        }}
      >
        <label>
          Função deste número
          <select
            aria-label={"Função de " + name}
            value={draft.purpose}
            disabled={busy}
            onChange={(event) => {
              const purpose = event.target.value as NumberPurpose;
              setDraft(
                purpose === "custom"
                  ? { ...draft, purpose }
                  : { ...numberPolicyPresets[purpose] },
              );
              setDirty(true);
            }}
          >
            <option value="official">Atendimento oficial</option>
            <option value="service_only">
              Integração com janela de 24 horas (Vinki)
            </option>
            <option value="custom">Personalizado</option>
          </select>
        </label>
        <p>
          Escolher uma função preenche as opções abaixo. Confira e salve para
          aplicar. A opção Vinki permite respostas de serviço dentro da janela
          de 24 horas e bloqueia templates. Linhas existentes mudam apenas
          depois de salvar.
        </p>
        <div className="number-policy-options">
          {options.map(([flag, title, description]) => (
            <label className="check-line" key={flag}>
              <input
                type="checkbox"
                checked={draft[flag]}
                disabled={busy}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    purpose: "custom",
                    [flag]: event.target.checked,
                  });
                  setDirty(true);
                }}
              />
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="number-policy-note">
          Receber mensagens e guardar o histórico continuam disponíveis. A
          janela de 24 horas vale somente para o número que recebeu a mensagem
          do cliente. Templates e outras mensagens enviadas não abrem nem
          renovam essa janela. Templates seguem suas permissões próprias. Ativar
          esta permissão não ativa o canal ou a área de atendimento.
        </p>
        <button className="primary" disabled={busy || !dirty}>
          Salvar função e permissões
        </button>
      </form>
    </details>
  );
}
