// O tsconfig da raiz carrega @cloudflare/workers-types, que declara
// Element.append(conteúdo do HTMLRewriter) e esconde o append do DOM. O painel
// do Fagoo usa document.body.append(nó); esta sobrecarga devolve a do DOM.
interface Element {
  append(...nodes: (Node | string)[]): void;
}
