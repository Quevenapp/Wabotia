import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { one, exec } from "../src/db";
import { defaults, uid, now, json, type Run } from "../src/types";
import { setSecret } from "../src/security";
import { inbound } from "../src/service";
import { processInbox, processRun } from "../src/engine";
import { decideInterpretation } from "../src/jev";
import { setFullPersonalData } from "../src/bot-actions/actions";

afterEach(() => vi.unstubAllGlobals());
const proposal = {
  action: "answer",
  text: "O prazo de entrega é de dois dias.",
  citations: [7],
  capability_id: null,
  menu_id: null,
  protocol_number: null,
  category_id: null,
  clarification: null,
  interpretation: {
    intent: "consultar prazo",
    summary: "O cliente quer o prazo de entrega do pedido.",
    missing_information: [],
  },
};
const context = {
  request: "Qual o prazo de entrega?",
  sources: [{ id: 7, text: "Prazo: dois dias." }],
};
const route = (choice = "answer", probability = 0.95, confidence = 0.91) => ({
  model: "jev-latest",
  answers: {
    route: {
      type: "choice",
      choice,
      confidence,
      probabilities: { [choice]: probability },
    },
  },
});
async function decisionFixture() {
  const run = { id: uid(), profile_id: uid(), phase: "attendant" } as Run;
  await setSecret(env, `jev:${run.profile_id}`, { key: "test-jev-only" });
  return run;
}
async function serviceFixture(enabled = true) {
  const profile = uid(),
    line = uid(),
    aiConnection = uid(),
    bot = uid();
  await exec(
    env,
    "INSERT INTO profiles(id,name,settings,enabled,created) VALUES(?,?,?,1,?)",
    profile,
    "JEV",
    JSON.stringify({ ...defaults, attendant_bot: bot, jev_enabled: enabled }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'meta','api','active',?,?)",
    line,
    profile,
    "WhatsApp",
    JSON.stringify({
      number: "5511999999999",
      service: { menu_mode: "manual" },
    }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO connections(id,profile_id,name,kind,mode,status,config,created) VALUES(?,?,?,'ai','api','active',?,?)",
    aiConnection,
    profile,
    "provedor de IA",
    JSON.stringify({ provider: "anthropic", model: "claude-haiku-5-5" }),
    now(),
  );
  await exec(
    env,
    "INSERT INTO bots(id,profile_id,connection_id,remote_profile,name,enabled) VALUES(?,?,?,'default','Atendente',1)",
    bot,
    profile,
    aiConnection,
  );
  await setSecret(env, `connection:${aiConnection}`, {
    api_key: "test-provider-key",
  });
  await setSecret(env, `jev:${profile}`, { key: "test-jev-only" });
  const received = await inbound(
    env,
    profile,
    {
      external_id: "5511888888888",
      message_id: uid(),
      text: "Qual o prazo de entrega da encomenda?",
    },
    `channel:${line}`,
    line,
  );
  return { profile, line, aiConnection, bot, conversation: received.conversation_id };
}

describe("interpretação do Atendente antes da decisão JEV", () => {
  it.each(["sem bot", "bot inexistente", "padrão", "ligada", "desligada"])(
    "consulta direta respeita a máscara pessoal: %s",
    async (option) => {
      const run = await decisionFixture();
      if (option === "bot inexistente") run.bot_id = uid();
      else if (option !== "sem bot") {
        const f = await serviceFixture();
        run.profile_id = f.profile;
        run.bot_id = f.bot;
        if (option !== "padrão")
          await exec(
            env,
            "UPDATE connections SET config=json_set(config,'$.bot_options',json(?)) WHERE id=?",
            JSON.stringify({ default: { mask_personal: option === "ligada" } }),
            f.aiConnection,
          );
      }
      const cpf = "123.456.789-09", tel = "+55 (11) 98888-7777";
      const bodies: string[] = [];
      vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
        bodies.push(String(options.body));
        return Response.json(route());
      }));
      // Isola a opção por bot: a regra da instalação não pode esconder uma falha.
      await setFullPersonalData(env, true);
      try {
        const result = await decideInterpretation(
          env,
          run,
          { ...proposal, text: `Cadastro ${cpf}, telefone ${tel}.` },
          { ...context, request: `Confira o CPF ${cpf} e telefone ${tel}.` },
          { jev_enabled: true },
          [],
        );
        expect(result.action).toBe("answer");
        expect(bodies).toHaveLength(2);
        for (const body of bodies) {
          if (option === "desligada") {
            expect(body).toContain(cpf);
            expect(body).toContain(tel);
          } else {
            expect(body).not.toContain(cpf);
            expect(body).not.toContain(tel);
            expect(body).toContain("[CPF_1]");
            expect(body).toContain("[TEL_1]");
          }
        }
      } finally {
        await setFullPersonalData(env, false);
      }
    },
  );

  it("executa provedor de IA primeiro e só consulta JEV depois de receber a interpretação", async () => {
    const f = await serviceFixture();
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        const body = options.body ? JSON.parse(String(options.body)) : null;
        calls.push({ url: String(url), body });
        if (String(url).includes("typesafe.ai")) return Response.json(route());
        return Response.json({ id: "msg_test", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: JSON.stringify(proposal) }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
      }),
    );
    await processInbox(env, f.profile);
    expect(calls).toHaveLength(0);
    let run = (await one(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      f.conversation,
    )) as Run;
    expect(run.status).toBe("queued");
    await exec(
      env,
      "UPDATE bot_runs SET context=? WHERE id=?",
      JSON.stringify(context),
      run.id,
    );
    run = (await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id)) as Run;
    await processRun(env, run);
    expect(calls.map((call) => new URL(call.url).hostname)).toEqual([
      "api.anthropic.com", "api.typesafe.ai", "api.typesafe.ai",
    ]);
    expect(JSON.stringify(calls[0].body.system)).toContain('interpretation');
    expect(calls[1].body.state.interpretation.summary).toBe(proposal.interpretation.summary);
    const outgoing = await one(
      env,
      "SELECT * FROM outbox WHERE dedupe=?",
      `run:${run.id}`,
    );
    expect(json(outgoing.payload).text).toBe(proposal.text);
    expect(
      (
        await one(
          env,
          "SELECT completion_handled FROM bot_runs WHERE id=?",
          run.id,
        )
      ).completion_handled,
    ).toBe(1);
  });

  it("desligado mantém a decisão do Atendente sem chamar JEV", async () => {
    const run = await decisionFixture(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await decideInterpretation(
        env,
        run,
        proposal,
        context,
        { jev_enabled: false },
        [],
      ),
    ).toEqual(proposal);
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await one(env, "SELECT * FROM jev_decisions WHERE run_id=?", run.id),
    ).toBeNull();
  });

  it("exige a interpretação antes de decidir e não chama o provedor para saída inválida", async () => {
    const run = await decisionFixture(),
      fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, interpretation: undefined },
      context,
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("human");
    expect(result.jev.reason).toBe("missing_interpretation");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["choice inexistente", route("admin"), "invalid_decision"],
    [
      "probabilidade alta mas baixa confiança",
      route("answer", 0.99, 0.2),
      "low_confidence",
    ],
    ["baixa probabilidade", route("answer", 0.6, 0.99), "low_confidence"],
    [
      "probabilidade ausente",
      {
        answers: { route: { type: "choice", choice: "answer", confidence: 1 } },
      },
      "invalid_decision",
    ],
  ])("encaminha para humano diante de %s", async (_label, response, reason) => {
    const run = await decisionFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response)),
    );
    const result = await decideInterpretation(
      env,
      run,
      proposal,
      context,
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("human");
    expect(result.jev.reason).toBe(reason);
  });

  it("guarda a decisão e não repete uma chamada cobrável ao retomar a conclusão", async () => {
    const run = await decisionFixture(),
      fetcher = vi.fn(async () => Response.json(route()));
    vi.stubGlobal("fetch", fetcher);
    const first = await decideInterpretation(
      env,
      run,
      proposal,
      context,
      { jev_enabled: true },
      [],
    );
    const again = await decideInterpretation(
      env,
      run,
      proposal,
      context,
      { jev_enabled: true },
      [],
    );
    expect(again).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      (
        await decideInterpretation(
          env,
          run,
          { ...proposal, text: "alterada" },
          context,
          { jev_enabled: true },
          [],
        )
      ).jev.reason,
    ).toBe("interpretation_changed");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falha HTTP ou timeout nunca libera a resposta; só 429 e 529 são tentados de novo dentro da chamada, e a execução não repete a decisão", async () => {
    // 429/529: a documentação manda repetir com espera (src/jev-client.ts):
    // 3 chamadas por ordem (a primeira e duas repetições). Timeout: uma por ordem. A segunda
    // decisão da mesma execução reaproveita a gravada, sem nova chamada.
    for (const [failure, expected] of [
      [async () => new Response("falha", { status: 429 }), 6],
      [
        async () => {
          throw new Error("timeout");
        },
        2,
      ],
    ] as const) {
      const run = await decisionFixture(),
        fetcher = vi.fn(failure);
      vi.stubGlobal("fetch", fetcher);
      const first = await decideInterpretation(
        env,
        run,
        proposal,
        context,
        { jev_enabled: true },
        [],
      );
      const again = await decideInterpretation(
        env,
        run,
        proposal,
        context,
        { jev_enabled: true },
        [],
      );
      expect(first.action).toBe("human");
      expect(again.action).toBe("human");
      expect(fetcher).toHaveBeenCalledTimes(expected);
    }
  }, 20_000);

  it("não oferece ação de especialista não autorizada ao JEV", async () => {
    const run = await decisionFixture();
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(
        JSON.parse(String(options.body)).questions.route.criteria.consult,
      ).toBeUndefined();
      return Response.json(route("consult"));
    });
    vi.stubGlobal("fetch", fetcher);
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, action: "consult", capability_id: "outro-perfil" },
      context,
      { jev_enabled: true, capabilities: [] },
      [],
    );
    expect(result.action).toBe("human");
  });

  it("permite ao JEV pedir esclarecimento sem entregar a resposta ainda não aprovada", async () => {
    const run = await decisionFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        expect(
          JSON.parse(String(options.body)).state.proposed_clarification,
        ).toBe("Qual é o seu pedido?");
        return Response.json(route("clarify"));
      }),
    );
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, clarification: "Qual é o seu pedido?" },
      context,
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("clarify");
    expect(result.text).toBe("Qual é o seu pedido?");
    expect(result.citations).toEqual([]);
  });

  it("inclui primeiro o resultado citado do especialista mesmo depois de muitos trechos e imagens", async () => {
    const run = { ...(await decisionFixture()), phase: "answer" } as Run;
    const sources = [
      ...Array.from({ length: 12 }, (_, id) => ({ id, text: `Trecho ${id}` })),
      { id: 999999, text: "Resultado financeiro do especialista" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, options: RequestInit) => {
        const state = JSON.parse(String(options.body)).state;
        expect(state.sources[0]).toEqual({
          id: 999999,
          text: "Resultado financeiro do especialista",
        });
        expect(state.sources).toHaveLength(10);
        expect(state.citations).toEqual([999999]);
        return Response.json(route());
      }),
    );
    const result = await decideInterpretation(
      env,
      run,
      { ...proposal, citations: [999999] },
      { ...context, sources },
      { jev_enabled: true },
      [],
    );
    expect(result.action).toBe("answer");
  });

  it("invalida a decisão se uma pessoa assume enquanto JEV responde", async () => {
    const f = await serviceFixture();
    await processInbox(env, f.profile);
    const run = (await one(
      env,
      "SELECT * FROM bot_runs WHERE conversation_id=?",
      f.conversation,
    )) as Run;
    await exec(
      env,
      "UPDATE bot_runs SET status='completed',result=?,context=? WHERE id=?",
      JSON.stringify(proposal),
      JSON.stringify(context),
      run.id,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await exec(
          env,
          "UPDATE conversations SET state='human',owner='person',epoch=epoch+1 WHERE id=?",
          f.conversation,
        );
        return Response.json(route());
      }),
    );
    await processRun(
      env,
      (await one(env, "SELECT * FROM bot_runs WHERE id=?", run.id)) as Run,
    );
    expect(
      await one(env, "SELECT * FROM outbox WHERE dedupe=?", `run:${run.id}`),
    ).toBeNull();
    expect(
      (
        await one(
          env,
          "SELECT state FROM conversations WHERE id=?",
          f.conversation,
        )
      ).state,
    ).toBe("human");
  });
});
