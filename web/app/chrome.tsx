// Peças da casca usadas pelas áreas: barra do topo da lista, pílula de
// presença, preferências e atalhos (web/DESIGN.md §2).
import React, { useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  ChevronDown,
  Monitor,
  Moon,
  Sun,
  Volume2,
} from "lucide-react";
import {
  Button,
  Dialog,
  MenuButton,
  Notice,
  Segmented,
  Switch,
  toast,
} from "../ui";
import { useTheme, type ThemeMode } from "../lib/theme";
import {
  notificationPermission,
  notificationsSupported,
  notifyPrefs,
  playChime,
  requestNotifications,
  saveNotifyPrefs,
} from "../lib/notifications";
import { plural } from "../lib/format";
import { useApp } from "./AppContext";

/** Pílula de presença: ● Online / ○ Offline. Abre a escolha em um diálogo. */
export function PresencePill() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={"presence-pill " + (app.online ? "online" : "offline")}
        onClick={() => setOpen(true)}
        aria-label={
          (app.online ? "Você está online" : "Você está offline") +
          ". Alterar presença"
        }
      >
        <i aria-hidden />
        {app.online ? "Online" : "Offline"}
      </button>
      {open && <PresenceDialog onClose={() => setOpen(false)} />}
    </>
  );
}

export function PresenceDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const choose = async (next: boolean) => {
    await app.setOnline(next);
    onClose();
  };
  return (
    <Dialog title="Sua presença" onClose={onClose} size="sm">
      <div className="presence-choices">
        <Button
          size="lg"
          full
          variant={app.online ? "primary" : "secondary"}
          busy={app.presenceBusy}
          onClick={() => choose(true)}
        >
          Ficar online
        </Button>
        <Button
          size="lg"
          full
          variant={app.online ? "secondary" : "primary"}
          disabled={app.presenceBusy}
          onClick={() => choose(false)}
        >
          Ficar offline
        </Button>
      </div>
      <p className="muted presence-note">
        Offline: novos atendimentos não são encaminhados a você. Ficar com o
        painel aberto não marca presença sozinho.
      </p>
      <p className="muted presence-note">
        {app.peopleOnline
          ? plural(app.peopleOnline, "pessoa online", "pessoas online") +
            " na equipe agora."
          : "Ninguém da equipe está online agora."}
      </p>
    </Dialog>
  );
}

/**
 * Barra do topo da coluna de lista: título da área, nome da área de
 * atendimento (troca quando há mais de uma), pílula de presença e ações.
 */
export function ListHeader({
  title,
  actions,
  presence = true,
  onBack,
}: {
  title: string;
  actions?: React.ReactNode;
  presence?: boolean;
  onBack?: () => void;
}) {
  const app = useApp();
  return (
    <header className="list-header">
      {onBack && (
        <button
          type="button"
          className="icon-button"
          aria-label="Voltar"
          onClick={onBack}
        >
          <ArrowLeft size={20} />
        </button>
      )}
      <div className="list-header-title">
        <h1>{title}</h1>
        {app.profiles.length > 1 ? (
          <MenuButton
            className="profile-switch"
            label="Trocar de área de atendimento"
            align="start"
            items={app.profiles.map((item) => ({
              label: item.name + (item.id === app.profile ? " ✓" : ""),
              onSelect: () => app.chooseProfile(item.id),
            }))}
          >
            <span className="truncate">{app.profileName}</span>
            <ChevronDown size={13} />
          </MenuButton>
        ) : (
          <span className="profile-name truncate">{app.profileName}</span>
        )}
      </div>
      <div className="list-header-actions">
        {presence && <PresencePill />}
        {actions}
      </div>
    </header>
  );
}

const themeOptions: { value: ThemeMode; label: string; icon: React.ReactNode }[] =
  [
    { value: "system", label: "Sistema", icon: <Monitor size={15} /> },
    { value: "light", label: "Claro", icon: <Sun size={15} /> },
    { value: "dark", label: "Escuro", icon: <Moon size={15} /> },
  ];

export function ThemePicker() {
  const { mode, setMode } = useTheme();
  return (
    <Segmented
      label="Aparência"
      value={mode}
      onChange={setMode}
      options={themeOptions}
      full
    />
  );
}

/** Ajustes pessoais: aparência, notificações do navegador e modo do painel. */
export function PreferencesDialog({ onClose }: { onClose: () => void }) {
  const app = useApp();
  const [prefs, setPrefs] = useState(notifyPrefs);
  const [permission, setPermission] = useState(notificationPermission);
  const update = (next: typeof prefs) => {
    setPrefs(next);
    saveNotifyPrefs(next);
  };
  return (
    <Dialog title="Ajustes" onClose={onClose}>
      <section className="prefs-section">
        <h3>Aparência</h3>
        <ThemePicker />
      </section>
      <section className="prefs-section">
        <h3>Notificações do navegador</h3>
        <div className="prefs-row">
          {prefs.enabled ? <Bell size={18} /> : <BellOff size={18} />}
          <div>
            <strong>Avisar com a aba em segundo plano</strong>
            <small>
              Mensagem nova em conversa sua, conversa nova na fila e protocolo
              atribuído ou perto do prazo.
            </small>
          </div>
          <Switch
            label="Notificações do navegador"
            checked={prefs.enabled && permission === "granted"}
            disabled={!notificationsSupported()}
            onChange={async (next) => {
              if (!next) return update({ ...prefs, enabled: false });
              const granted = await requestNotifications();
              setPermission(notificationPermission());
              update({ ...prefs, enabled: granted });
              if (granted) toast("Notificações ligadas.");
            }}
          />
        </div>
        {!notificationsSupported() && (
          <Notice tone="warn">Este navegador não oferece notificações.</Notice>
        )}
        {notificationsSupported() && permission === "denied" && (
          <Notice tone="warn">
            As notificações estão bloqueadas para este site. Libere nas
            permissões do navegador e tente de novo.
          </Notice>
        )}
        <div className="prefs-row">
          <Volume2 size={18} />
          <div>
            <strong>Som curto</strong>
            <small>Toca junto com o aviso, só com a aba em segundo plano.</small>
          </div>
          <Switch
            label="Som de aviso"
            checked={prefs.sound}
            onChange={(next) => {
              update({ ...prefs, sound: next });
              if (next) playChime();
            }}
          />
        </div>
      </section>
      <section className="prefs-section">
        <h3>Modo do painel</h3>
        <Segmented
          label="Modo do painel"
          value={app.panelMode}
          onChange={app.setPanelMode}
          full
          options={[
            { value: "guided", label: "Simplificado" },
            { value: "advanced", label: "Avançado" },
          ]}
        />
        <p className="muted prefs-help">
          O modo avançado mostra consentimentos, execuções, entregas, eventos e
          identificadores técnicos em Gestão.
        </p>
      </section>
    </Dialog>
  );
}

const shortcuts: [string[], string][] = [
  [["Ctrl", "K"], "Buscar na lista (também /)"],
  [["↑", "↓"], "Percorrer a lista de conversas"],
  [["Enter"], "Enviar mensagem"],
  [["Shift", "Enter"], "Quebrar linha na mensagem"],
  [["Ctrl", "Shift", "T"], "Transferir a conversa aberta"],
  [["Esc"], "Limpar a busca, fechar painel ou diálogo"],
  [["Alt", "1…6"], "Trocar de área (Conversas, Protocolos, Equipe…)"],
  [["?"], "Mostrar estes atalhos"],
];
export function ShortcutList() {
  return (
    <dl className="shortcut-list">
      {shortcuts.map(([keys, label]) => (
        <div key={label}>
          <dt>
            {keys.map((key, index) => (
              <React.Fragment key={key}>
                {index > 0 && <span aria-hidden> + </span>}
                <kbd>{key}</kbd>
              </React.Fragment>
            ))}
          </dt>
          <dd>{label}</dd>
        </div>
      ))}
    </dl>
  );
}
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Atalhos de teclado" onClose={onClose} size="sm">
      <ShortcutList />
    </Dialog>
  );
}
