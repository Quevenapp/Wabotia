// Preferências: as leituras que outros domínios usam e que dependem de outros
// domínios (por isso fora do public.ts, que fica leve; ver o comentário lá).
// Situações e transições (Documentos: save, B2 e transition); cada item de
// situationList/transitionList traz as colunas da função SQL (ver framework.ts).
export { situationBaseColor, situationBaseLabel, situationBases } from "./center.ts";
export { situationList, situationOf, transitionAllowed, transitionList, transitionRule } from "./framework.ts";
// Meu Negócio (Documentos: save, cópia, lixeira, conversões e frete pago).
export { bizCostVisible, bizFreight, bizRole, bizUnitCost } from "./business-rules.ts";
