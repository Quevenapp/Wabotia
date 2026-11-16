// Ordem do texto em collation C (bytes UTF-8), como o oráculo.
const encoder = new TextEncoder();
export function compareText(a: string, b: string) {
  const x = encoder.encode(a),
    y = encoder.encode(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}
