// Composer da conversa (web/DESIGN.md §4): texto, anexos com prévia e
// progresso, voz, localização, contato, nota interna, resposta citada e
// edição. Um pedido sem confirmação fica guardado com a mesma
// Idempotency-Key para uma nova tentativa segura.
import React, {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  AtSign,
  Contact,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  List,
  Lock,
  MapPin,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Reply,
  Send,
  Smile,
  Square,
  Sticker,
  Trash2,
  X,
} from "lucide-react";
import Recorder from "opus-recorder";
import encoderPath from "opus-recorder/dist/encoderWorker.min.js?url";
import { useApp } from "../app/AppContext";
import type { Row } from "../lib/api";
import { clock, fileSize, parse } from "../lib/format";
import { Confirm, IconButton, MenuButton, Notice, type MenuAction } from "../ui";
import { MessageInput } from "../ui/chat";
import { AudioPlayer } from "./Media";
import { Popover } from "./Popover";
import { uploadFile } from "./upload";

const EMOJIS = [
  "😀", "😊", "😉", "😂", "😍", "🤔", "😅", "😢",
  "👍", "🙏", "👏", "🙌", "👋", "🤝", "💪", "👀",
  "❤️", "🎉", "✅", "⚠️", "📎", "📄", "📍", "⏰",
];
const MAX_FILES = 10;
type Kind = "text" | "document" | "sticker" | "location" | "contacts";
type Attachment = { file: File; preview: string; progress: number | null };

export type ComposerHandle = { addFiles: (files: File[]) => void; focus: () => void };

function readPreview(file: File): Promise<string> {
  // A política de conteúdo só aceita imagens próprias ou data:, não blob:.
  if (!file.type.startsWith("image/") || file.size > 6 * 1024 * 1024)
    return Promise.resolve("");
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => resolve("");
    reader.readAsDataURL(file);
  });
}

export const Composer = React.forwardRef<
  ComposerHandle,
  {
    detail: Row;
    windowClosed: boolean;
    quote: Row | null;
    setQuote: (message: Row | null) => void;
    edit: Row | null;
    setEdit: (message: Row | null) => void;
    refresh: () => Promise<any>;
    onSent: (result: Row, sent: { text: string; attachments: number }) => void;
    onMenu: () => void;
    onTicket: () => void;
  }
>(function Composer(
  { detail, windowClosed, quote, setQuote, edit, setEdit, refresh, onSent, onMenu, onTicket },
  ref,
) {
  const app = useApp();
  const c = detail.conversation,
    cap: Row = detail.capabilities || {};
  const root = app.root;
  const [text, setText] = useState(""),
    [items, setItems] = useState<Attachment[]>([]),
    [voice, setVoice] = useState<File | null>(null),
    [voiceUrl, setVoiceUrl] = useState(""),
    [recording, setRecording] = useState(false),
    [seconds, setSeconds] = useState(0),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(""),
    [error, setError] = useState(""),
    [kind, setKind] = useState<Kind>("text"),
    [special, setSpecial] = useState<Row>({}),
    [mentions, setMentions] = useState<string[]>([]),
    [note, setNote] = useState(false),
    [emoji, setEmoji] = useState(false),
    [abandon, setAbandon] = useState(false),
    [hasPending, setHasPending] = useState(false);
  const recorder = useRef<any>(null),
    discard = useRef(false),
    key = useRef(crypto.randomUUID()),
    pending = useRef<any>(null),
    mounted = useRef(true),
    input = useRef<HTMLTextAreaElement>(null),
    picker = useRef<HTMLInputElement>(null),
    emojiButton = useRef<HTMLButtonElement>(null);
  const members: Row[] = parse(detail.group?.participants, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recorder.current?.close();
    };
  }, []);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () =>
        setSeconds((value) => {
          if (value >= 119) {
            recorder.current?.stop();
            return value;
          }
          return value + 1;
        }),
      1000,
    );
    return () => clearInterval(timer);
  }, [recording]);
  // Áudio e vídeo podem usar blob: na prévia.
  useEffect(() => {
    if (!voice) return setVoiceUrl("");
    const url = URL.createObjectURL(voice);
    setVoiceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [voice]);
  // Editar: o texto da mensagem vai para o campo.
  useEffect(() => {
    if (edit) {
      setText(edit.text || "");
      setNote(false);
      input.current?.focus();
    }
  }, [edit?.id]);
  useEffect(() => {
    if (quote) input.current?.focus();
  }, [quote?.id]);

  async function addFiles(files: File[]) {
    if (!files.length || pending.current) return;
    setVoice(null);
    setError("");
    const room = MAX_FILES - items.length;
    if (files.length > room)
      setError(`Envie até ${MAX_FILES} arquivos por mensagem.`);
    const added = await Promise.all(
      files.slice(0, Math.max(0, room)).map(async (file) => ({
        file,
        preview: await readPreview(file),
        progress: null,
      })),
    );
    if (mounted.current) setItems((current) => current.concat(added).slice(0, MAX_FILES));
  }
  useImperativeHandle(ref, () => ({ addFiles, focus: () => input.current?.focus() }));

  async function record() {
    setError("");
    try {
      const rec = new Recorder({
        encoderPath,
        numberOfChannels: 1,
        encoderApplication: 2048,
        encoderBitRate: 24000,
      });
      recorder.current = rec;
      discard.current = false;
      rec.ondataavailable = (data: Uint8Array) => {
        if (mounted.current) {
          if (!discard.current)
            setVoice(
              new File([data as BlobPart], "mensagem-de-voz.ogg", {
                type: "audio/ogg; codecs=opus",
              }),
            );
          setRecording(false);
        }
        rec.close();
        recorder.current = null;
      };
      await rec.start();
      if (!mounted.current) {
        rec.close();
        return;
      }
      setItems([]);
      setSeconds(0);
      setRecording(true);
    } catch {
      recorder.current?.close();
      recorder.current = null;
      setRecording(false);
      setError(
        "Não foi possível abrir o microfone. Permita o acesso no navegador e use uma página HTTPS.",
      );
    }
  }

  const reset = () => {
    pending.current = null;
    setHasPending(false);
    key.current = crypto.randomUUID();
    setText("");
    setItems([]);
    setVoice(null);
    setQuote(null);
    setSpecial({});
    setKind("text");
    setMentions([]);
  };

  async function sendNote() {
    if (!text.trim() || app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      await app.api(
        `${root}/conversations/${c.id}/actions`,
        "POST",
        { action: "note", text },
        undefined,
        key.current,
      );
      key.current = crypto.randomUUID();
      setText("");
      // Volta para a mensagem ao cliente: a próxima escrita não vira nota por engano.
      setNote(false);
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function send() {
    if (busy || recording) return;
    if (note && !edit && !pending.current) return sendNote();
    if (!canSend) return;
    if (app.demoBlocked()) return;
    setBusy(true);
    setError("");
    try {
      if (edit) {
        await app.api(
          `${root}/conversations/${c.id}/message-actions`,
          "POST",
          { action: "edit", message_id: edit.id, text },
          undefined,
          key.current,
        );
        setEdit(null);
        reset();
      } else {
        if (!pending.current) {
          const attachments: string[] = [];
          const files = voice ? [voice] : items.map((item) => item.file);
          for (let index = 0; index < files.length; index++) {
            const file = files[index];
            attachments.push(
              await uploadFile(app.api, root, file, (n) => {
                setProgress(`Enviando ${file.name}: ${n}%`);
                if (!voice)
                  setItems((current) =>
                    current.map((item, position) =>
                      position === index ? { ...item, progress: n } : item,
                    ),
                  );
              }),
            );
          }
          const content: any = {
            type: voice ? "voice" : kind,
            ...(quote ? { reply_to: quote.id } : {}),
            ...(mentions.length ? { mentions } : {}),
          };
          if (kind === "location")
            content.location = {
              latitude: Number(special.latitude),
              longitude: Number(special.longitude),
              name: special.name || "",
              address: special.address || "",
            };
          if (kind === "contacts")
            content.contacts = [{ name: special.name, phone: special.phone }];
          pending.current = { action: "reply", text, attachments, content };
          setHasPending(true);
        }
        setProgress("Confirmando envio…");
        const request = pending.current;
        const result = await app.api(
          `${root}/conversations/${c.id}/actions`,
          "POST",
          request,
          undefined,
          key.current,
        );
        onSent(result || {}, {
          text: request.text,
          attachments: request.attachments.length,
        });
        reset();
      }
      await refresh();
    } catch (e: any) {
      setError(e.message);
      setItems((current) => current.map((item) => ({ ...item, progress: null })));
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }

  const locked = busy || hasPending || recording;
  const specialReady =
    kind === "location"
      ? special.latitude !== undefined &&
        special.latitude !== "" &&
        special.longitude !== undefined &&
        special.longitude !== ""
      : kind === "contacts"
        ? !!String(special.name || "").trim() && !!String(special.phone || "").trim()
        : false;
  const canSend =
    hasPending ||
    (edit
      ? !!text.trim()
      : note
        ? !!text.trim()
        : !!text.trim() || items.length > 0 || !!voice || specialReady);
  const showMic =
    !!cap.voice && !text.trim() && !items.length && !voice && !edit && !note && kind === "text" && !hasPending;

  function pick(nextKind: Kind, accept = "") {
    setKind(nextKind);
    setNote(false);
    if (picker.current) {
      picker.current.accept = accept;
      picker.current.click();
    }
  }
  const plus: MenuAction[] = [
    {
      label: "Arquivos",
      icon: <Paperclip size={18} />,
      hint: "Fotos, vídeos, áudios e outros arquivos. O tipo é detectado.",
      onSelect: () => pick("text"),
    },
    {
      label: "Documento",
      icon: <FileText size={18} />,
      hint: "Envia o arquivo como documento, sem compactar.",
      onSelect: () => pick("document"),
    },
    {
      label: "Figurinha",
      icon: <Sticker size={18} />,
      hidden: !cap.sticker,
      hint: "WebP 512 × 512.",
      onSelect: () => pick("sticker", "image/webp"),
    },
    {
      label: "Localização",
      icon: <MapPin size={18} />,
      hidden: !cap.location,
      onSelect: () => {
        setKind("location");
        setNote(false);
        setSpecial({});
      },
    },
    {
      label: "Contato",
      icon: <Contact size={18} />,
      hidden: !cap.contacts,
      onSelect: () => {
        setKind("contacts");
        setNote(false);
        setSpecial({});
      },
    },
    {
      label: "Menu",
      icon: <List size={18} />,
      separator: true,
      onSelect: onMenu,
    },
    {
      label: "Protocolo",
      icon: <FileIcon size={18} />,
      onSelect: onTicket,
    },
    {
      label: note ? "Voltar para mensagem ao cliente" : "Nota interna",
      icon: <Lock size={18} />,
      onSelect: () => {
        setNote(!note);
        setKind("text");
        input.current?.focus();
      },
    },
  ];

  const insertEmoji = (value: string) => {
    const element = input.current;
    const start = element?.selectionStart ?? text.length,
      end = element?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + value + text.slice(end));
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  return (
    <div className={"composer-wrap" + (note ? " note-mode" : "")}>
      {windowClosed && !note && (
        <div className="composer-strip warn" role="status">
          <Lock size={14} />
          <span>
            Fora da janela de 24h. A mensagem fica na fila até o cliente
            escrever.
          </span>
        </div>
      )}
      {error && (
        <div className="composer-notice">
          <Notice tone="error" onClose={() => setError("")}>
            {error}
          </Notice>
        </div>
      )}
      {hasPending && !busy && (
        <div className="composer-strip pending" role="status">
          <span>O pedido está guardado para uma tentativa segura.</span>
          <button type="button" onClick={() => void send()}>
            Tentar novamente
          </button>
          <button type="button" className="danger" onClick={() => setAbandon(true)}>
            Abandonar pedido
          </button>
        </div>
      )}
      {quote && !edit && (
        <div className="composer-strip quote">
          <Reply size={16} />
          <span className="truncate">
            <strong>Respondendo</strong> {String(quote.text || "Anexo").slice(0, 140)}
          </span>
          <button type="button" aria-label="Cancelar citação" onClick={() => setQuote(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {edit && (
        <div className="composer-strip quote">
          <Pencil size={16} />
          <span className="truncate">
            <strong>Editando mensagem</strong> {String(edit.text || "").slice(0, 140)}
          </span>
          <button
            type="button"
            aria-label="Cancelar edição"
            onClick={() => {
              setEdit(null);
              setText("");
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {note && (
        <div className="composer-strip note" role="status">
          <Lock size={14} />
          <span>Nota interna: só a equipe vê. Não é enviada ao cliente.</span>
          <button type="button" aria-label="Sair da nota interna" onClick={() => setNote(false)}>
            <X size={16} />
          </button>
        </div>
      )}
      {kind === "location" && (
        <div className="composer-form">
          <strong>
            <MapPin size={15} /> Localização
          </strong>
          <label>
            Latitude
            <input
              type="number"
              step="any"
              placeholder="-23,5505"
              disabled={locked}
              value={special.latitude ?? ""}
              onChange={(event) => setSpecial({ ...special, latitude: event.target.value })}
            />
          </label>
          <label>
            Longitude
            <input
              type="number"
              step="any"
              placeholder="-46,6333"
              disabled={locked}
              value={special.longitude ?? ""}
              onChange={(event) => setSpecial({ ...special, longitude: event.target.value })}
            />
          </label>
          <label>
            Nome do local
            <input
              disabled={locked}
              value={special.name || ""}
              onChange={(event) => setSpecial({ ...special, name: event.target.value })}
            />
          </label>
          <label>
            Endereço
            <input
              disabled={locked}
              value={special.address || ""}
              onChange={(event) => setSpecial({ ...special, address: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="icon-button sm"
            aria-label="Cancelar localização"
            disabled={locked}
            onClick={() => setKind("text")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {kind === "contacts" && (
        <div className="composer-form">
          <strong>
            <Contact size={15} /> Compartilhar contato
          </strong>
          <label>
            Nome
            <input
              disabled={locked}
              value={special.name || ""}
              onChange={(event) => setSpecial({ ...special, name: event.target.value })}
            />
          </label>
          <label>
            Telefone com DDI
            <input
              placeholder="5511999999999"
              inputMode="tel"
              disabled={locked}
              value={special.phone || ""}
              onChange={(event) => setSpecial({ ...special, phone: event.target.value })}
            />
          </label>
          <button
            type="button"
            className="icon-button sm"
            aria-label="Cancelar contato"
            disabled={locked}
            onClick={() => setKind("text")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {mentions.length > 0 && (
        <div className="composer-strip mentions">
          <AtSign size={14} />
          <span className="truncate">
            Menções:{" "}
            {mentions
              .map((id) => members.find((member) => member.id === id)?.name || id)
              .join(", ")}
          </span>
          <button type="button" onClick={() => setMentions([])}>
            Limpar
          </button>
        </div>
      )}
      {(items.length > 0 || voice) && (
        <div className="composer-tray">
          {voice ? (
            <div className="tray-voice">
              <Mic size={18} />
              {voiceUrl && <AudioPlayer src={voiceUrl} label="Prévia da mensagem de voz" />}
              <small>{fileSize(voice.size)}</small>
              <button
                type="button"
                className="icon-button sm"
                aria-label="Descartar gravação"
                disabled={locked}
                onClick={() => setVoice(null)}
              >
                <Trash2 size={16} />
              </button>
            </div>
          ) : (
            <ul className="tray-files" aria-label="Anexos">
              {items.map((item, index) => (
                <li key={index} className={item.preview ? "image" : ""}>
                  {item.preview ? (
                    <img src={item.preview} alt="" />
                  ) : (
                    <span className="tray-icon">
                      {item.file.type.startsWith("image/") ? (
                        <ImageIcon size={20} />
                      ) : (
                        <FileText size={20} />
                      )}
                    </span>
                  )}
                  <span className="tray-name">
                    <strong className="truncate">{item.file.name}</strong>
                    <small>
                      {item.progress !== null
                        ? `Enviando ${item.progress}%`
                        : fileSize(item.file.size)}
                    </small>
                  </span>
                  {item.progress !== null && (
                    <span
                      className="tray-progress"
                      role="progressbar"
                      aria-valuenow={item.progress}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label={"Envio de " + item.file.name}
                    >
                      <i style={{ width: item.progress + "%" }} />
                    </span>
                  )}
                  <button
                    type="button"
                    aria-label={"Remover " + item.file.name}
                    disabled={locked}
                    onClick={() =>
                      setItems(items.filter((_, position) => position !== index))
                    }
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <small className="tray-hint">
            {kind === "document" && !voice ? "Será enviado como documento. " : ""}
            {kind === "sticker" && !voice ? "Será enviado como figurinha. " : ""}
            WhatsApp oficial: foto até 5 MB; vídeo/áudio até 16 MB; documento até
            100 MB. Gravação até 2 minutos.
          </small>
        </div>
      )}
      {progress && (
        <p className="composer-progress" role="status">
          {progress}
        </p>
      )}
      {recording ? (
        <div className="composer is-recording" role="status">
          <IconButton
            label="Descartar gravação"
            tone="danger"
            onClick={() => {
              discard.current = true;
              recorder.current?.stop();
            }}
          >
            <Trash2 size={20} />
          </IconButton>
          <span className="recording-dot" aria-hidden />
          <span className="recording-time">{clock(seconds)}</span>
          <span className="recording-wave" aria-hidden>
            {Array.from({ length: 24 }, (_, index) => (
              <i key={index} style={{ animationDelay: (index % 8) * 90 + "ms" }} />
            ))}
          </span>
          <small>até 2:00</small>
          <button
            type="button"
            className="composer-send"
            aria-label="Parar e revisar a gravação"
            title="Parar e revisar"
            onClick={() => recorder.current?.stop()}
          >
            <Square size={18} />
          </button>
        </div>
      ) : (
        <div className="composer">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-hidden
            tabIndex={-1}
            onChange={(event) => {
              void addFiles(Array.from(event.target.files || []));
              event.target.value = "";
            }}
          />
          <MenuButton label="Anexar e outras ações" items={plus} align="start" disabled={locked}>
            <Plus size={24} />
          </MenuButton>
          <div className="composer-field">
            <button
              type="button"
              ref={emojiButton}
              className="icon-button composer-emoji"
              aria-label="Emojis"
              title="Emojis"
              aria-expanded={emoji}
              disabled={locked}
              onClick={() => setEmoji(!emoji)}
            >
              <Smile size={21} />
            </button>
            <MessageInput
              ref={input}
              value={text}
              onChange={setText}
              onSend={() => void send()}
              disabled={locked}
              maxLength={12000}
              placeholder={
                note
                  ? "Nota interna para a equipe"
                  : edit
                    ? "Novo texto da mensagem"
                    : "Mensagem"
              }
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files || []);
                if (files.length && !note && !edit) {
                  event.preventDefault();
                  if (kind !== "document" && kind !== "sticker") setKind("text");
                  void addFiles(files);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && (quote || edit || note)) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (edit) {
                    setEdit(null);
                    setText("");
                  } else if (quote) setQuote(null);
                  else setNote(false);
                }
              }}
            />
            {cap.mentions && c.chat_type === "group" && !note && (
              <MenuButton
                label="Mencionar participante"
                className="icon-button composer-emoji"
                disabled={locked || !members.length}
                items={members.map((member) => ({
                  label: member.name || member.id,
                  onSelect: () =>
                    setMentions((current) => [...new Set([...current, member.id])]),
                }))}
              >
                <AtSign size={20} />
              </MenuButton>
            )}
          </div>
          {showMic ? (
            <button
              type="button"
              className="composer-send"
              aria-label="Gravar mensagem de voz"
              title="Gravar mensagem de voz"
              disabled={locked}
              onClick={() => void record()}
            >
              <Mic size={21} />
            </button>
          ) : (
            <button
              type="button"
              className={"composer-send" + (note ? " note" : "")}
              aria-label={
                hasPending
                  ? "Consultar ou tentar novamente"
                  : note
                    ? "Salvar nota interna"
                    : edit
                      ? "Salvar edição"
                      : "Enviar"
              }
              title={
                hasPending
                  ? "Consultar / tentar novamente"
                  : note
                    ? "Salvar nota interna"
                    : edit
                      ? "Salvar edição"
                      : "Enviar"
              }
              disabled={busy || !canSend}
              onClick={() => void send()}
            >
              {note ? <Lock size={19} /> : <Send size={20} />}
            </button>
          )}
        </div>
      )}
      {emoji && (
        <Popover
          anchor={emojiButton.current}
          label="Emojis"
          className="emoji-picker"
          onClose={() => setEmoji(false)}
        >
          {EMOJIS.map((value) => (
            <button
              type="button"
              key={value}
              aria-label={"Inserir " + value}
              onClick={() => insertEmoji(value)}
            >
              {value}
            </button>
          ))}
        </Popover>
      )}
      {abandon && (
        <Confirm
          title="Abandonar pedido"
          confirmLabel="Abandonar pedido"
          danger
          onClose={() => setAbandon(false)}
          onConfirm={() => {
            setAbandon(false);
            pending.current = null;
            setHasPending(false);
            key.current = crypto.randomUUID();
            setError("Pedido abandonado. Confira Entregas antes de reenviar.");
          }}
        >
          <p>
            Abandonar este pedido? Confira Entregas antes de enviar outro para
            evitar duplicidade.
          </p>
        </Confirm>
      )}
    </div>
  );
});
