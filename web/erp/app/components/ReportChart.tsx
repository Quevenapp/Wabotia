import { useId, useState } from 'react';
import './report-chart.css';

/**
 * Gráficos simples dos relatórios do ERP, em SVG desenhado aqui (sem biblioteca): colunas por período (uma ou duas séries,
 * um eixo, zero na base) e barras horizontais para ranking. Cada marca tem o valor ao passar o mouse ou focar; a tabela
 * com todos os números fica por baixo, na tela que usa o gráfico.
 */
export interface ChartSeries { name: string; values: number[] }
const TICKS = 4;
function niceStep(max: number) {
  if (max <= 0) return 1;
  const raw = max / TICKS, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
}

export function ColumnChart({ title, labels, series, format, shortFormat }: { title: string; labels: string[]; series: ChartSeries[]; format: (value: number) => string; shortFormat?: (value: number) => string }) {
  const id = useId(), [hover, setHover] = useState<{ s: number; i: number } | null>(null);
  const all = series.flatMap(s => s.values), maxRaw = Math.max(0, ...all), minRaw = Math.min(0, ...all);
  const step = niceStep(Math.max(maxRaw, -minRaw) || 1), top = Math.ceil(maxRaw / step) * step || step, bottom = Math.floor(minRaw / step) * step;
  const width = Math.max(320, labels.length * (series.length * 14 + 14) + 64), height = 220, left = 56, right = 8, plotTop = 12, plotBottom = height - 28;
  const y = (v: number) => plotTop + ((top - v) / (top - bottom)) * (plotBottom - plotTop);
  const slot = (width - left - right) / Math.max(1, labels.length), bar = Math.max(3, Math.min(28, (slot - 6) / series.length - 2));
  const ticks: number[] = []; for (let v = bottom; v <= top + step / 2; v += step) ticks.push(v);
  const every = Math.max(1, Math.ceil(labels.length / Math.floor((width - left) / 56)));
  const short = shortFormat ?? format, current = hover ? `${labels[hover.i]} · ${series[hover.s]!.name}: ${format(series[hover.s]!.values[hover.i]!)}` : '';
  return <figure className="report-chart" aria-labelledby={`${id}-title`}>
    <figcaption id={`${id}-title`} className="report-chart-title">{title}</figcaption>
    {series.length > 1 && <ul className="report-chart-legend">{series.map((s, i) => <li key={s.name}><span className={`report-chart-swatch report-series-${i + 1}`} aria-hidden="true" />{s.name}</li>)}</ul>}
    <div className="report-chart-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`${title}. Os valores estão na tabela abaixo.`}>
        {ticks.map(v => <g key={v} className="report-chart-grid"><line x1={left} x2={width - right} y1={y(v)} y2={y(v)} className={v === 0 ? 'report-chart-zero' : undefined} />
          <text x={left - 6} y={y(v) + 4} textAnchor="end">{short(v)}</text></g>)}
        {labels.map((label, i) => <g key={`${label}-${i}`}>
          {series.map((s, k) => {
            const v = s.values[i] ?? 0, x = left + i * slot + (slot - series.length * (bar + 2)) / 2 + k * (bar + 2), y0 = y(0), y1 = y(v);
            return <rect key={s.name} className={`report-series-${k + 1}${hover && (hover.i !== i || hover.s !== k) ? ' report-chart-dim' : ''}`} x={x} width={bar}
              y={Math.min(y0, y1)} height={Math.max(v === 0 ? 0 : 1, Math.abs(y1 - y0))} rx={2} tabIndex={0}
              onMouseEnter={() => setHover({ s: k, i })} onMouseLeave={() => setHover(null)} onFocus={() => setHover({ s: k, i })} onBlur={() => setHover(null)}>
              <title>{`${label} · ${s.name}: ${format(v)}`}</title></rect>;
          })}
          {i % every === 0 && <text className="report-chart-axis" x={left + i * slot + slot / 2} y={height - 10} textAnchor="middle">{label}</text>}
        </g>)}
      </svg>
    </div>
    <p className="report-chart-readout" aria-live="polite">{current || ' '}</p>
  </figure>;
}

export function BarList({ title, items, format }: { title: string; items: { label: string; value: number; note?: string }[]; format: (value: number) => string }) {
  const max = Math.max(0, ...items.map(item => item.value)) || 1;
  return <figure className="report-chart" aria-label={title}>
    <figcaption className="report-chart-title">{title}</figcaption>
    <ol className="report-barlist">{items.map((item, i) => <li key={`${item.label}-${i}`} title={`${item.label}: ${format(item.value)}`}>
      <span className="report-barlist-label">{item.label}{item.note && <small> · {item.note}</small>}</span>
      <span className="report-barlist-track" aria-hidden="true"><span className="report-series-1" style={{ width: `${Math.max(0, (item.value / max) * 100)}%` }} /></span>
      <span className="report-barlist-value">{format(item.value)}</span>
    </li>)}</ol>
  </figure>;
}

/** Reais curtos para o eixo: "R$ 1,2 mil", "R$ 3 mi". */
export const shortMoney = (cents: number) => {
  const v = cents / 100, a = Math.abs(v);
  const text = a >= 1e6 ? `${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi` : a >= 1e3 ? `${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  return `R$ ${text}`;
};
export const fullMoney = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
