import React, { useState } from "react";
import { Check, Copy, Loader2, Search, X } from "lucide-react";

type ButtonProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> & {
  /** Estilo: principal (brand), secundário (contorno), fantasma ou perigo. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** Compatível com o painel antigo: `secondary` equivale a variant="secondary". */
  secondary?: boolean;
  size?: "sm" | "md" | "lg";
  /** Mostra progresso no próprio botão e bloqueia novo clique. */
  busy?: boolean;
  full?: boolean;
  icon?: React.ReactNode;
  type?: "button" | "submit";
};

export function Button({
  variant,
  secondary = false,
  size = "md",
  busy = false,
  full = false,
  icon,
  type = "button",
  className = "",
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const kind = variant || (secondary ? "secondary" : "primary");
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={[
        "button",
        kind === "primary" ? "" : kind,
        size === "md" ? "" : size,
        full ? "full" : "",
        busy ? "busy" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {busy ? <Loader2 className="spin" size={17} aria-hidden /> : icon}
      {children}
    </button>
  );
}

/** Botão só de ícone: `label` é obrigatório (vira aria-label e dica). */
export const IconButton = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
    label: string;
    active?: boolean;
    busy?: boolean;
    size?: "sm" | "md" | "lg";
    tone?: "default" | "brand" | "danger";
  }
>(function IconButton(
  {
    label,
    active,
    busy,
    size = "md",
    tone = "default",
    className = "",
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={active}
      disabled={disabled || busy}
      className={[
        "icon-button",
        size === "md" ? "" : size,
        tone === "default" ? "" : tone,
        active ? "active" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {busy ? <Loader2 className="spin" size={18} aria-hidden /> : children}
    </button>
  );
});

export type PillTone =
  | "ok"
  | "warn"
  | "danger"
  | "muted"
  | "bot"
  | "ticket"
  | "brand";

/** Pílula de estado: fundo suave da cor, texto legível. */
export function Pill({
  tone = "muted",
  icon,
  children,
  className = "",
  title,
}: {
  tone?: PillTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span className={`pill tone-${tone} ${className}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

/** Chip de filtro com contador. */
export function Chip({
  active,
  count,
  tone,
  onClick,
  children,
  icon,
}: {
  active?: boolean;
  count?: number | null;
  tone?: PillTone;
  onClick?: () => void;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={
        "chip" + (active ? " active" : "") + (tone ? " tone-" + tone : "")
      }
      aria-pressed={!!active}
      onClick={onClick}
    >
      {icon}
      <span>{children}</span>
      {count ? <b>{count > 999 ? "999+" : count}</b> : null}
    </button>
  );
}

/** Contador em bolinha (não lidas, atrasados). */
export function CountBadge({
  count,
  tone = "accent",
  label,
}: {
  count: number;
  tone?: "accent" | "danger" | "muted";
  label?: string;
}) {
  if (!count) return null;
  return (
    <b className={"count-badge " + tone} aria-label={label}>
      {count > 99 ? "99+" : count}
    </b>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  busy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={"switch" + (busy ? " busy" : "")}
      disabled={disabled || busy}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

/** Seletor segmentado (abas curtas dentro de uma área). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  full,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string; count?: number; icon?: React.ReactNode }[];
  label: string;
  full?: boolean;
}) {
  return (
    <div
      className={"segmented" + (full ? " full" : "")}
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
        const index = options.findIndex((option) => option.value === value);
        const next =
          options[
            (index + (event.key === "ArrowRight" ? 1 : -1) + options.length) %
              options.length
          ];
        onChange(next.value);
        event.preventDefault();
        const buttons = event.currentTarget.querySelectorAll("button");
        (buttons[options.indexOf(next)] as HTMLElement | undefined)?.focus();
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          onClick={() => onChange(option.value)}
        >
          {option.icon}
          {option.label}
          {option.count ? <b>{option.count}</b> : null}
        </button>
      ))}
    </div>
  );
}

export const SearchBox = React.forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    label?: string;
    onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    autoFocus?: boolean;
    /** Campo que Ctrl+K e "/" focam (um por tela). */
    global?: boolean;
  }
>(function SearchBox(
  { value, onChange, placeholder, label, onKeyDown, autoFocus, global },
  ref,
) {
  return (
    <div className="search-box">
      <Search size={17} aria-hidden />
      <input
        ref={ref}
        type="search"
        value={value}
        autoFocus={autoFocus}
        data-global-search={global ? "" : undefined}
        aria-label={label || placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.stopPropagation();
            onChange("");
          }
          onKeyDown?.(event);
        }}
      />
      {value && (
        <button
          type="button"
          className="search-clear"
          aria-label="Limpar busca"
          onClick={() => onChange("")}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
});

/**
 * Campo de formulário: rótulo acima, controle, ajuda curta abaixo.
 * Mantém a assinatura usada pelas páginas de Gestão (options, textarea…).
 */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  options,
  placeholder,
  required = false,
  help,
  disabled,
  rows,
  min,
  max,
  maxLength,
  autoComplete,
  emptyOption = "Selecione...",
}: {
  label: React.ReactNode;
  value: any;
  onChange: (value: string) => void;
  type?: string;
  options?: any[];
  placeholder?: string;
  required?: boolean;
  help?: React.ReactNode;
  disabled?: boolean;
  rows?: number;
  min?: number | string;
  max?: number | string;
  maxLength?: number;
  autoComplete?: string;
  /** Texto da opção vazia do select; `null` remove a opção. */
  emptyOption?: string | null;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {options ? (
        <select
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          required={required}
          disabled={disabled}
        >
          {emptyOption !== null && <option value="">{emptyOption}</option>}
          {options.map((option: any) => (
            <option key={option.id ?? option[0]} value={option.id ?? option[0]}>
              {option.name ?? option[1]}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          rows={rows}
          maxLength={maxLength}
        />
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          min={min}
          max={max}
          maxLength={maxLength}
          autoComplete={autoComplete}
        />
      )}
      {help && <small>{help}</small>}
    </label>
  );
}

export function CopyButton({
  value,
  label = "Copiar",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="icon-button sm"
      aria-label={copied ? "Copiado" : label}
      title={copied ? "Copiado" : label}
      onClick={() =>
        navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
      }
    >
      {copied ? <Check size={16} /> : <Copy size={16} />}
    </button>
  );
}
