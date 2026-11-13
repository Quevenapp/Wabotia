// Mídia das mensagens: imagem com visualizador, vídeo, áudio compacto,
// documento, localização e contato (mobile/DESIGN.md §5).
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  MapPin,
  Pause,
  Play,
  UserPlus,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { Row } from "../lib/api";
import { clock, fileSize, phone } from "../lib/format";
import { Avatar } from "../ui";

export const mediaUrl = (root: string, id: string) =>
  `/api/${root}/media/${id}/content`;
export const isImage = (type: string) =>
  /^image\/(jpeg|png|webp|gif)/.test(type || "");

function documentIcon(type: string, name: string) {
  const text = (type + " " + name).toLowerCase();
  if (/pdf|word|document|text|\.txt|\.md|\.docx?/.test(text)) return FileText;
  if (/sheet|excel|csv|\.xlsx?/.test(text)) return FileSpreadsheet;
  if (/zip|rar|compressed|\.7z|tar/.test(text)) return FileArchive;
  if (/^audio|audio\//.test(text)) return FileAudio;
  if (/^video|video\//.test(text)) return FileVideo;
  return File;
}

/** Player de áudio compacto: tocar, barra de progresso, duração e velocidade. */
export function AudioPlayer({ src, label }: { src: string; label?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false),
    [duration, setDuration] = useState(0),
    [position, setPosition] = useState(0),
    [rate, setRate] = useState(1),
    [failed, setFailed] = useState(false);
  const known = Number.isFinite(duration) && duration > 0;
  return (
    <div className={"audio-player" + (failed ? " failed" : "")}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onError={() => setFailed(true)}
      />
      <button
        type="button"
        className="audio-play"
        aria-label={playing ? "Pausar áudio" : "Tocar áudio"}
        onClick={() => {
          const element = audio.current;
          if (!element) return;
          if (element.paused) void element.play().catch(() => setFailed(true));
          else element.pause();
        }}
      >
        {playing ? <Pause size={20} /> : <Play size={20} />}
      </button>
      <div className="audio-track">
        <input
          type="range"
          min={0}
          max={known ? duration : 1}
          step={0.05}
          value={known ? Math.min(position, duration) : 0}
          disabled={!known}
          aria-label={label || "Posição do áudio"}
          style={
            {
              "--played": known ? `${(position / duration) * 100}%` : "0%",
            } as React.CSSProperties
          }
          onChange={(event) => {
            if (audio.current) audio.current.currentTime = Number(event.target.value);
            setPosition(Number(event.target.value));
          }}
        />
        <small>
          {failed
            ? "Não foi possível tocar"
            : known
              ? clock(playing || position > 0 ? position : duration)
              : "Áudio"}
        </small>
      </div>
      <button
        type="button"
        className="audio-rate"
        aria-label={`Velocidade ${rate}x. Alterar`}
        onClick={() => {
          const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1;
          setRate(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
      >
        {String(rate).replace(".", ",")}x
      </button>
    </div>
  );
}

/** Um anexo dentro da bolha. */
export function MessageMedia({
  file,
  root,
  onOpenImage,
  sticker,
}: {
  file: Row;
  root: string;
  onOpenImage: (id: string) => void;
  sticker?: boolean;
}) {
  const url = mediaUrl(root, file.id),
    inline = url + "?inline=1";
  const type = String(file.type || "");
  if (isImage(type))
    return (
      <button
        type="button"
        className={"media-image" + (sticker ? " sticker" : "")}
        onClick={() => onOpenImage(file.id)}
        aria-label={"Abrir imagem " + (file.name || "")}
      >
        <img src={inline} alt={file.name || "Imagem"} loading="lazy" />
      </button>
    );
  if (type.startsWith("video/"))
    return (
      <div className="media-video">
        <video controls preload="metadata" src={inline} />
        <a className="media-download" href={url} download aria-label="Baixar vídeo">
          <Download size={15} />
        </a>
      </div>
    );
  if (type.startsWith("audio/"))
    return (
      <div className="media-audio">
        <AudioPlayer src={inline} label={file.name} />
        <a className="media-download" href={url} download aria-label="Baixar áudio">
          <Download size={15} />
        </a>
      </div>
    );
  const Icon = documentIcon(type, file.name || "");
  return (
    <div className="media-document">
      <span className="media-document-icon">
        <Icon size={22} />
      </span>
      <span className="media-document-text">
        <strong className="truncate">{file.name || "Anexo"}</strong>
        <small>{fileSize(file.size) || "Documento"}</small>
      </span>
      <a
        href={inline}
        target="_blank"
        rel="noreferrer"
        aria-label={"Abrir " + (file.name || "documento") + " em nova aba"}
        title="Abrir em nova aba"
      >
        <ExternalLink size={17} />
      </a>
      <a
        href={url}
        download={file.name || true}
        aria-label={"Baixar " + (file.name || "documento")}
        title="Baixar"
      >
        <Download size={17} />
      </a>
    </div>
  );
}

/** Cartão de localização desenhado com os tokens de mapa; abre no mapa. */
export function LocationCard({ location }: { location: Row }) {
  const lat = encodeURIComponent(location.latitude),
    lon = encodeURIComponent(location.longitude);
  return (
    <a
      className="location-card"
      href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`}
      target="_blank"
      rel="noreferrer"
    >
      <span className="location-map" aria-hidden>
        <MapPin size={30} />
      </span>
      <span className="location-text">
        <strong>{location.name || "Localização"}</strong>
        {location.address && <small>{location.address}</small>}
        <small>
          {location.latitude}, {location.longitude} · Abrir no mapa
        </small>
      </span>
    </a>
  );
}

export function ContactCard({
  contact,
  onSave,
}: {
  contact: Row;
  onSave?: (contact: Row) => void;
}) {
  return (
    <div className="shared-contact">
      <Avatar name={contact.name || contact.phone || "?"} size={40} />
      <span>
        <strong className="truncate">{contact.name || "Contato"}</strong>
        {contact.phone && <small>{phone(String(contact.phone))}</small>}
      </span>
      {onSave && (
        <button type="button" onClick={() => onSave(contact)}>
          <UserPlus size={15} /> Salvar
        </button>
      )}
    </div>
  );
}

export type ViewerImage = { id: string; name: string; at?: number };

/** Visualizador de imagens sobre a página: zoom, baixar, próxima/anterior. */
export function ImageViewer({
  images,
  startId,
  root,
  onClose,
}: {
  images: ViewerImage[];
  startId: string;
  root: string;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      images.findIndex((image) => image.id === startId),
    ),
  );
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  const image = images[index];
  const go = (delta: number) => {
    setZoom(1);
    setIndex((current) =>
      Math.min(images.length - 1, Math.max(0, current + delta)),
    );
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.focus();
    return () => previous?.focus?.();
  }, []);
  if (!image) return null;
  const url = mediaUrl(root, image.id);
  return createPortal(
    <div
      className="image-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={"Imagem " + (image.name || "")}
      tabIndex={-1}
      ref={box}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        } else if (event.key === "ArrowLeft") go(-1);
        else if (event.key === "ArrowRight") go(1);
        else if (event.key === "+" || event.key === "=")
          setZoom((value) => Math.min(4, value + 0.5));
        else if (event.key === "-") setZoom((value) => Math.max(1, value - 0.5));
        else if (event.key === "Tab") {
          // Mantém o foco dentro do visualizador.
          const items = Array.from(
            box.current?.querySelectorAll<HTMLElement>("button, a[href]") || [],
          );
          if (!items.length) return;
          const first = items[0],
            last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <header>
        <span className="truncate">
          {image.name || "Imagem"}
          {images.length > 1 && (
            <small>
              {index + 1} de {images.length}
            </small>
          )}
        </span>
        <button
          type="button"
          aria-label="Diminuir zoom"
          disabled={zoom <= 1}
          onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
        >
          <ZoomOut size={20} />
        </button>
        <button
          type="button"
          aria-label="Aumentar zoom"
          disabled={zoom >= 4}
          onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
        >
          <ZoomIn size={20} />
        </button>
        <a href={url} download={image.name || true} aria-label="Baixar imagem">
          <Download size={20} />
        </a>
        <button type="button" aria-label="Fechar" onClick={onClose}>
          <X size={22} />
        </button>
      </header>
      <div
        className={"image-viewer-stage" + (zoom > 1 ? " zoomed" : "")}
        onClick={(event) => event.target === event.currentTarget && onClose()}
      >
        <img
          key={image.id}
          src={url + "?inline=1"}
          alt={image.name || "Imagem"}
          style={
            zoom > 1
              ? { width: zoom * 100 + "%", maxWidth: "none", maxHeight: "none" }
              : undefined
          }
          onDoubleClick={() => setZoom((value) => (value > 1 ? 1 : 2))}
        />
      </div>
      {images.length > 1 && (
        <>
          <button
            type="button"
            className="image-viewer-nav prev"
            aria-label="Imagem anterior"
            disabled={index === 0}
            onClick={() => go(-1)}
          >
            <ChevronLeft size={26} />
          </button>
          <button
            type="button"
            className="image-viewer-nav next"
            aria-label="Próxima imagem"
            disabled={index === images.length - 1}
            onClick={() => go(1)}
          >
            <ChevronRight size={26} />
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
