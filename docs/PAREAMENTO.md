# Pareamento com Vinki e Fagoo

No Vinki, abra **Gerente → Wabotia** no navegador da central. No Fagoo, abra **Preferências → Sistema → Wabotia**. Informe somente a URL HTTPS desta instalação e um nome reconhecível. Gere o código; no Wabotia, abra **Integrações → Parear Vinki ou Fagoo**, digite o código, confira o sistema e a instalação e escolha perfil, permissões, linhas/grupos e bots. Aprove e volte ao sistema de origem para verificar a aprovação.

O código dura dez minutos e somente um administrador Wabotia pode aprová-lo. A credencial é trocada entre servidores, sem aparecer em URL, painel ou logs. Para enviar mensagens, selecione a consulta das linhas, **Enviar mensagens pelas linhas escolhidas** e **Enviar mensagens nas conversas autorizadas**. Nenhum pareamento concede modelos pagos. O Vinki pede `free_only:true`, também exigido no servidor para aplicações pareadas como Vinki, e só admite envio na janela aberta com saldo da franquia estimada. Configure o preset Vinki nas linhas. O contador local não substitui a fatura Meta. No Fagoo, envio de serviço acima da franquia depende da política explícita das linhas. Permissões de consulta podem ser aprovadas separadamente.

Revogar no Wabotia interrompe todas as chaves daquele vínculo. **Desconectar** no outro sistema também revoga o próprio vínculo. Cada instalação tem aplicação e chave separadas; um aplicativo não pode revogar outro. Chaves vencem em um ano, exigindo novo pareamento. Se a resposta final da troca se perder, revogue o vínculo anterior e gere outro código. Nunca aprove códigos recebidos de terceiros sem conferir a instalação que iniciou o pedido.

## Implantação coordenada

Aplicar a migração Wabotia `0010_pairing.sql` e atualizar Worker e painel. Os clientes estão preparados nos checkouts locais `D:/Code/wabotia/Vinki-pairing` (branch `sessao/wabotia-pareamento`) e `D:/Code/wabotia/Fagoo-pairing` (branch `codex/wabotia-pareamento`). Nenhum deploy ou release foi realizado.

- Vinki V4: integrar a alteração, aplicar `cloud/loja/migrations/0003_wabotia.sql`, atualizar Worker da loja, gerar `web/local/dist` e recompilar a central com a ponte Rust. A nuvem da loja e sua identidade Ed25519 devem estar configuradas. Ver `docs/contrato/wabotia.md` e `docs/wabotia.md` nesse checkout.
- Fagoo: integrar a alteração, aplicar `supabase/migrations/202611090001_wabotia_pairing.sql`, atualizar `workers/erp-api` e o frontend. Ver `docs/operations/wabotia.md` nesse checkout e o procedimento próprio de release assinado.

Os segredos dos clientes são cifrados usando configuração privada já instalada (vínculo da nuvem Vinki/chave de serviço Fagoo); mudar essas chaves exige refazer o pareamento. O Wabotia guarda apenas hashes dos códigos, cifra a credencial temporária e a elimina após a entrega. A manutenção agendada revoga aprovações expiradas não consumidas e remove pedidos anônimos antigos.

Se a configuração privada mudar e o cliente não conseguir abrir a credencial anterior, a tela mostra **Esquecer conexão local**. Primeiro revogue a aplicação anterior no Wabotia e confirme isso na tela; depois esqueça a configuração e gere outro código. Essa recuperação apaga somente o estado local e não promete revogação remota.

Validação dos clientes: Vinki Worker com D1 real; frontend compilado, 61 testes aprovados e 19 testes que exigem core real pulados. A ponte Rust recebeu revisão estática, sem compilação ou testes por ausência de Cargo/rustc/toolchain WSL neste ambiente. Fagoo validado com Postgres PGlite real, rotas HTTP de autenticação/MFA e verificação TypeScript. Não houve homologação em produção ou envio real.

## API

Públicas: `POST /api/pairing/start` com `client` (`vinki` ou `fagoo`) e `instance_name`; retorna `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`. `POST /api/pairing/token` usa `client` e `device_code`; pode retornar `authorization_pending`, `connected` ou erro `slow_down`, `expired_token`, `access_denied`, `invalid_grant`. Respeite o intervalo mínimo de cinco segundos.

Administrativas: `GET /api/v1/pairings`; `POST /api/v1/pairings/lookup` com `user_code`; `POST /api/v1/pairings/{id}/approve` com `profile_id`, `scopes`, `number_ids`, `pool_ids`, `bot_ids`; `POST /api/v1/pairings/{id}/deny`; `DELETE /api/v1/pairings/{id}`. A aplicação autenticada pode chamar `POST /api/v1/pairings/disconnect` para revogar seu próprio vínculo.

O fluxo usa a separação entre código de usuário e segredo do dispositivo descrita em [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628). As rotas são um contrato próprio, não um servidor OAuth genérico.
