// /erp-rpc/<nome> dentro do objeto: chama a função registrada do motor numa
// transação (provas 5 e 6). Fase 0, prova 2: ainda sem funções registradas.
export async function handleRpc(
  _ctx: DurableObjectState,
  _profile: string,
  name: string,
  _request: Request,
): Promise<Response> {
  return Response.json(
    {
      code: "0A000",
      message: `RPC ${name} ainda não portado.`,
    },
    { status: 501 },
  );
}
