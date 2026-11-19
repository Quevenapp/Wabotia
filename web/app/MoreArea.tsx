// Aba "Mais" do celular: o que no computador fica no trilho e no menu da
// conta (Contatos, Gestão, presença, aparência, ajustes, sair).
import React, { useState } from "react";
import {
  BookOpen,
  Building2,
  ChevronRight,
  Code2,
  Contact,
  Info,
  LogOut,
  Settings,
  SlidersHorizontal,
  Ticket,
  Users,
} from "lucide-react";
import { Avatar, Switch } from "../ui";
import { linkProps } from "../lib/routes";
import { canEnterManagement, managementContext } from "../management/registry";
import { useApp } from "./AppContext";
import { PreferencesDialog, ThemePicker } from "./chrome";
import { sourceLinkLabel, useSourceLink } from "../lib/source";

export function MoreArea() {
  const app = useApp();
  const management = managementContext({ statusLoaded: app.statusLoaded,
    modules: app.modules, role: app.me.role, access: app.me.access ?? null });
  const [prefs, setPrefs] = useState(false);
  const source = useSourceLink();
  return (
    <div className="more-area">
      <header className="more-user">
        <Avatar
          name={app.me.name}
          seed={app.me.id}
          size={56}
          online={app.online}
        />
        <div>
          <strong>{app.me.name}</strong>
          <small>
            {app.isAdmin ? "Administrador" : "Atendente"} · {app.profileName}
          </small>
          <small>{app.online ? "Você está online" : "Você está offline"}</small>
        </div>
        <Switch
          label="Presença no atendimento"
          checked={app.online}
          busy={app.presenceBusy}
          onChange={(next) => void app.setOnline(next)}
        />
      </header>
      <section className="more-group">
        {app.moduleOn("queue") && (
          <a className="more-link" {...linkProps({ area: "queue" })}>
            <Ticket size={21} />
            <span>Fila de senhas</span>
            <ChevronRight size={18} />
          </a>
        )}
        <a className="more-link" {...linkProps({ area: "contacts" })}>
          <Contact size={21} />
          <span>Contatos</span>
          <ChevronRight size={18} />
        </a>
        {canEnterManagement(management) && (
          <a className="more-link" {...linkProps({ area: "erp" })}>
            <Building2 size={21} />
            <span>ERP</span>
            <ChevronRight size={18} />
          </a>
        )}
        <a
          className="more-link"
          {...linkProps({ area: "admin", page: "overview" })}
        >
          <Settings size={21} />
          <span>Gestão</span>
          <ChevronRight size={18} />
        </a>
      </section>
      {app.profiles.length > 1 && (
        <section className="more-group">
          <h2>Área de atendimento</h2>
          {app.profiles.map((item) => (
            <button
              type="button"
              className="more-link"
              key={item.id}
              aria-pressed={item.id === app.profile}
              onClick={() => app.chooseProfile(item.id)}
            >
              <Users size={21} />
              <span>{item.name}</span>
              {item.id === app.profile && <b>✓</b>}
            </button>
          ))}
        </section>
      )}
      <section className="more-group">
        <h2>Aparência</h2>
        <div className="more-pad">
          <ThemePicker />
        </div>
      </section>
      <section className="more-group">
        <button
          type="button"
          className="more-link"
          onClick={() => setPrefs(true)}
        >
          <SlidersHorizontal size={21} />
          <span>Ajustes e notificações</span>
          <ChevronRight size={18} />
        </button>
        <a
          className="more-link"
          href="/install"
          target="_blank"
          rel="noreferrer"
        >
          <BookOpen size={21} />
          <span>Guia de instalação</span>
          <ChevronRight size={18} />
        </a>
        <a
          className="more-link"
          href="/api-docs"
          target="_blank"
          rel="noreferrer"
        >
          <Code2 size={21} />
          <span>Documentação da API</span>
          <ChevronRight size={18} />
        </a>
        <a
          className="more-link"
          href={source.url}
          target="_blank"
          rel="noreferrer"
        >
          <Info size={21} />
          <span>{sourceLinkLabel(source)}</span>
          <ChevronRight size={18} />
        </a>
      </section>
      <section className="more-group">
        <button
          type="button"
          className="more-link danger"
          onClick={() => void app.logout()}
        >
          <LogOut size={21} />
          <span>Sair</span>
        </button>
      </section>
      {prefs && <PreferencesDialog onClose={() => setPrefs(false)} />}
    </div>
  );
}
