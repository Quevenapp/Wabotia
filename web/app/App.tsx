// Entrada do painel em /app: sessão, área de atendimento e as áreas da casca.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, onApiState, type Row } from "../lib/api";
import { demoApi, demoMe, demoProfile } from "../lib/demo";
import { navigate, onBlocked, useRoute, type Route } from "../lib/routes";
import { applyTheme } from "../lib/theme";
import { Button, Confirm, Empty, Spinner, ToastHost } from "../ui";
import { Login } from "../site/Login";
import { AppProvider, useApp } from "./AppContext";
import { Shell } from "./Shell";
import { MoreArea } from "./MoreArea";
import { ConversationsArea } from "../conversations/ConversationsArea";
import { TicketsArea } from "../tickets/TicketsArea";
import { TeamArea } from "../team/TeamArea";
import { CallsArea } from "../calls/CallsArea";
import { AdminArea } from "../admin/AdminArea";
import { ContactsArea } from "../admin/ContactsArea";

function Areas() {
  const app = useApp();
  const route = useRoute();
  const [blocked, setBlocked] = useState<Route | null>(null);
  useEffect(() => onBlocked(setBlocked), []);
  const needsProfile = route.area !== "admin" && route.area !== "more";
  return (
    <Shell>
      {!app.profile && needsProfile ? (
        <div className="area">
          <Empty
            title="Área de atendimento"
            description={
              app.isAdmin
                ? "Não foi possível abrir o atendimento da empresa. Tente novamente."
                : "Peça ao administrador para liberar seu acesso ao atendimento da empresa."
            }
            action={
              app.isAdmin ? (
                <Button onClick={() => void app.reloadSession()}>
                  Tentar novamente
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : route.area === "conversations" ? (
        <ConversationsArea key={app.profile} id={route.id} />
      ) : route.area === "tickets" ? (
        <TicketsArea key={app.profile} id={route.id} />
      ) : route.area === "team" ? (
        <TeamArea key={app.profile} sub={route.sub} id={route.id} />
      ) : route.area === "calls" ? (
        <CallsArea key={app.profile} />
      ) : route.area === "contacts" ? (
        <ContactsArea key={app.profile} />
      ) : route.area === "more" ? (
        <MoreArea />
      ) : (
        <AdminArea page={route.page || "overview"} />
      )}
      {blocked && (
        <Confirm
          title="Alterações ainda não salvas"
          confirmLabel="Descartar e continuar"
          cancelLabel="Continuar editando"
          onClose={() => setBlocked(null)}
          onConfirm={() => {
            const target = blocked;
            setBlocked(null);
            navigate(target, { force: true });
          }}
        >
          <p>
            Suas alterações ainda não foram salvas. Volte para salvá-las ou
            descarte antes de sair.
          </p>
        </Confirm>
      )}
    </Shell>
  );
}

export function App() {
  const demo = new URLSearchParams(location.search).has("demo");
  const [me, setMe] = useState<Row | null>(demo ? demoMe : null),
    [profiles, setProfiles] = useState<Row[]>(demo ? [demoProfile] : []),
    [checked, setChecked] = useState(demo),
    [error, setError] = useState(""),
    [offline, setOffline] = useState(false);
  const current = useRef<Row | null>(me);
  current.current = me;
  const init = useCallback(async () => {
    try {
      const actor = await api("v1/me");
      let areas = await api("v1/profiles");
      if (actor.role === "admin" && areas.length === 0) {
        await api("v1/installation/area/bootstrap", "POST", {});
        areas = await api("v1/profiles");
      }
      setProfiles(areas);
      setMe(actor);
      setError("");
    } catch (e: any) {
      if (e.status === 401) {
        setMe(null);
        setProfiles([]);
      } else if (!current.current)
        setError(e.message || "Não foi possível abrir a Área de atendimento.");
    } finally {
      setChecked(true);
    }
  }, []);
  useEffect(() => {
    applyTheme();
    if (!demo) void init();
  }, []);
  useEffect(
    () =>
      onApiState((state) => {
        setOffline(!state.online);
        // Sessão encerrada em outra aba ou expirada: volta para a entrada.
        if (state.unauthorized && current.current && !demo) void init();
      }),
    [init, demo],
  );
  if (!checked)
    return (
      <div className="loading">
        <Spinner label="Abrindo seu atendimento…" />
      </div>
    );
  if (!me)
    return (
      <>
        {error ? (
          <div className="loading">
            <Empty
              title="Não foi possível abrir o painel"
              description={error}
              action={<Button onClick={() => void init()}>Tentar de novo</Button>}
            />
          </div>
        ) : (
          <Login ready={init} />
        )}
        <ToastHost />
      </>
    );
  return (
    <AppProvider
      key={me.id + ":" + me.role}
      demo={demo}
      api={demo ? demoApi : api}
      me={me}
      profiles={profiles}
      offline={offline && !demo}
      reloadSession={init}
    >
      <Areas />
      <ToastHost />
    </AppProvider>
  );
}
