// Preferências › Sistema › Permissões no ERP (decisão de 16/11; motor 308e227):
// no lugar de "Usuários" do Fagoo. As pessoas e o papel no ERP vêm do núcleo
// (Gestão → Pessoas e acessos, porta `people`); aqui o administrador do ERP
// ajusta, de cada pessoa, o tipo, os horários de acesso e as permissões finas
// (GET/POST /v1/usuarios/:id/controles, que continuam no ERP; UserControls é a
// tela do Fagoo). Convite, papel, senha, segundo fator e sessões ficam no
// núcleo: a tela leva para lá.
import React, {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import UserControls from "./app/components/UserControls";
import { Icon } from "./app/components/Icon";
import type { UsersController } from "./app/lib/access-users-model";
import { erpPorts } from "./ports";
import {
  ERP_ROLES,
  ERP_ROLE_LABELS,
  type ErpPerson,
  type ErpRole,
} from "./people";
import "./app/components/real-users.css";

const aborted = (error: unknown) =>
  error instanceof DOMException && error.name === "AbortError";

export default function ErpPermissions({
  controller,
}: {
  controller: UsersController;
}) {
  const ports = erpPorts();
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const me = snapshot.membership?.user_id ?? null;
  const admin =
    snapshot.phase === "ready" && snapshot.membership?.role === "admin";
  const [people, setPeople] = useState<ErpPerson[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<ErpRole | "">("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!admin || !ports) return;
    const request = new AbortController();
    setError("");
    ports
      .people(request.signal)
      .then((list) => {
        if (!request.signal.aborted) setPeople(list);
      })
      .catch((failure) => {
        if (!request.signal.aborted && !aborted(failure)) {
          setPeople(null);
          setError(
            "Não foi possível carregar as pessoas da área. Tente novamente.",
          );
        }
      });
    return () => request.abort();
  }, [admin, ports, reload]);

  const shown = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    return (people ?? []).filter(
      (person) =>
        (!role || person.role === role) &&
        (!term || person.name.toLocaleLowerCase("pt-BR").includes(term)),
    );
  }, [people, search, role]);

  if (!admin)
    return (
      <section className="real-state-panel">
        <h1>Permissões não liberadas</h1>
        <p>Somente o administrador do ERP ajusta as permissões das pessoas.</p>
      </section>
    );
  const peopleLink = ports?.openPeople ? (
    <button
      type="button"
      className="secondary-button"
      onClick={ports.openPeople}
    >
      <Icon name="up-right-from-square" size={11} />
      Abrir Pessoas e acessos
    </button>
  ) : null;
  return (
    <div className="real-users erp-permissions">
      <header className="real-heading">
        <div>
          <h1>Permissões no ERP</h1>
          <p>
            As pessoas e o papel de cada uma no ERP vêm de Gestão › Pessoas e
            acessos. Aqui você ajusta o tipo, os horários de acesso e as
            permissões de cada pessoa.
          </p>
        </div>
        {peopleLink}
      </header>
      <p className="real-notice">
        Convidar alguém, trocar o papel no ERP, redefinir a senha ou o segundo
        fator e encerrar sessões: em Gestão › Pessoas e acessos do Wabotia.
      </p>
      <div
        className="erp-permissions-filters"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "flex-end",
        }}
      >
        <label className="form-field" htmlFor="erp-people-search">
          Pesquisar por nome
          <input
            id="erp-people-search"
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor="erp-people-role">
          Papel no ERP
          <select
            id="erp-people-role"
            value={role}
            onChange={(event) => setRole(event.target.value as ErpRole | "")}
          >
            <option value="">Todos</option>
            {ERP_ROLES.map((item) => (
              <option key={item} value={item}>
                {ERP_ROLE_LABELS[item]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() => setReload((value) => value + 1)}
        >
          Recarregar
        </button>
      </div>
      {error && (
        <p className="real-alert" role="alert">
          {error}
        </p>
      )}
      {!people && !error && (
        <p role="status" className="real-help">
          Carregando as pessoas…
        </p>
      )}
      {people && !people.length && (
        <div className="empty-state">
          <h2>Ninguém tem papel no ERP</h2>
          <p>Dê o papel no ERP às pessoas em Gestão › Pessoas e acessos.</p>
        </div>
      )}
      {people && people.length > 0 && (
        <>
          <div
            className="table-scroll"
            role="region"
            aria-label="Pessoas com papel no ERP"
            tabIndex={0}
          >
            <table className="data-table real-users-table">
              <thead>
                <tr>
                  <th scope="col">Nome</th>
                  <th scope="col">Papel no ERP</th>
                  <th scope="col">
                    <span className="sr-only">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((person) => (
                  <tr
                    key={person.user_id}
                    className={
                      open === person.user_id ? "is-selected" : undefined
                    }
                  >
                    <td>
                      <strong>{person.name}</strong>
                      {person.user_id === me && (
                        <span className="real-help"> (você)</span>
                      )}
                    </td>
                    <td>{ERP_ROLE_LABELS[person.role]}</td>
                    <td>
                      <button
                        type="button"
                        className="text-button"
                        aria-expanded={open === person.user_id}
                        onClick={() =>
                          setOpen(
                            open === person.user_id ? null : person.user_id,
                          )
                        }
                      >
                        <Icon name="shield-halved" size={11} />
                        {open === person.user_id
                          ? "Fechar"
                          : "Tipo, horários e permissões"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!shown.length && (
            <p className="real-help">Ninguém com esse nome ou papel.</p>
          )}
          <p className="real-help">
            {people.length.toLocaleString("pt-BR")} pessoa(s) com papel no ERP.
          </p>
        </>
      )}
      {open && people?.some((person) => person.user_id === open) && (
        <section
          className="real-editor real-users-editor"
          aria-label={`Permissões de ${people.find((person) => person.user_id === open)!.name}`}
        >
          <h2>{people.find((person) => person.user_id === open)!.name}</h2>
          <UserControls
            key={open}
            controller={controller}
            user={{ user_id: open }}
            actor={me}
          />
        </section>
      )}
    </div>
  );
}
