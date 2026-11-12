# Pareamento com Vinki e Fagoo

No Vinki, abra **Gerente → Wabotia** no navegador da central. No Fagoo, abra **Preferências → Sistema → Wabotia**. Informe somente a URL HTTPS desta instalação e um nome reconhecível. Gere o código; no Wabotia, abra **Integrações → Parear Vinki ou Fagoo**, digite o código, confira o sistema e a instalação e escolha perfil, permissões, linhas/grupos e bots. Aprove e volte ao sistema de origem para verificar a aprovação.

O código dura dez minutos e somente um administrador Wabotia pode aprová-lo. A credencial é trocada entre servidores, sem aparecer em URL, painel ou logs. Para enviar mensagens, selecione a consulta das linhas, **Enviar mensagens pelas linhas escolhidas** e **Enviar mensagens nas conversas autorizadas**. Nenhum pareamento concede modelos pagos. O Vinki pede `free_only:true`, também exigido no servidor para aplicações pareadas como Vinki: esse campo legado impede templates e não impõe saldo ou teto local. Configure o preset Vinki nas linhas; as respostas exigem janela real de 24 horas. As mensagens entregues são contabilizadas por categoria, sem estimativa de preço. Permissões de consulta podem ser aprovadas separadamente.

Revogar no Wabotia interrompe todas as chaves daquele vínculo. **Desconectar** no outro sistema também revoga o próprio vínculo. Cada instalação tem aplicação e chave separadas; um aplicativo não pode revogar outro. Chaves vencem em um ano, exigindo novo pareamento. Se a resposta final da troca se perder, revogue o vínculo anterior e gere outro código. Nunca aprove códigos recebidos de terceiros sem conferir a instalação que iniciou o pedido.

## Implantação coordenada

O Wabotia `0.10.0` foi publicado em 09/11/2026 na distribuição oficial `wabotia.queven.app` e na instalação operacional `wabotia.queven.com.br`, com as migrações `0010` a `0013`. O upgrade remoto de `0.9.0` preservou os dados existentes e validou aprovação, troca da credencial e revogação dos dois clientes em homologação. Os clientes estão nos checkouts locais `D:/Code/wabotia/Vinki-pairing` e `D:/Code/wabotia/Fagoo-pairing`; cada um exige sua própria implantação.

- Vinki V4: nuvem publicada em `https://vinki.queven.com.br`, com as migrações `0001`–`0003` aplicadas e o código integrado ao `main`. A central Android foi recompilada e seu APK de bancada está disponível no checkout; a nova nuvem ainda aguarda o aparelho real. Antes do primeiro vínculo, alinhe o segredo da nuvem ao código desse aparelho. Ver `docs/contrato/wabotia.md` e `docs/wabotia.md` no checkout Vinki.
- Fagoo: release assinada `v0.3.1` publicada como Latest e instalada pelo atualizador oficial em `https://demo.fagoo.com.br` em 09/11/2026. O atualizador fez backup e concluiu sem erro; API e frontend confirmaram o commit `1c5ac861c7ba02d13fc61d5dd14dcac64af36977`. A consulta administrativa de Wabotia retornou `200` com estado desconectado, validando a nova tabela/RPC da migração `202611090001_wabotia_pairing.sql`; a mesma rota anônima retornou `401`. Nenhum pareamento real foi criado nesta verificação. Ver `docs/operations/wabotia.md` nesse checkout e o procedimento próprio de release assinado.

Os segredos dos clientes são cifrados usando configuração privada já instalada (vínculo da nuvem Vinki/chave de serviço Fagoo); mudar essas chaves exige refazer o pareamento. O Wabotia guarda apenas hashes dos códigos, cifra a credencial temporária e a elimina após a entrega. A manutenção agendada revoga aprovações expiradas não consumidas e remove pedidos anônimos antigos.

Se a configuração privada mudar e o cliente não conseguir abrir a credencial anterior, a tela mostra **Esquecer conexão local**. Primeiro revogue a aplicação anterior no Wabotia e confirme isso na tela; depois esqueça a configuração e gere outro código. Essa recuperação apaga somente o estado local e não promete revogação remota.

Validação dos clientes em 09/11/2026: Vinki Worker com D1 real (56 testes), frontend com núcleo real (80 testes) e Rust sem Quall (95 testes distintos, incluindo sete contra a nuvem local e o pareamento pela FFI). Nenhum desses testes foi pulado. Rust e bibliotecas Android arm64/armv7 foram compilados. A suíte Android passou em 110 testes; dois testes de aparelho físico ficaram pulados. Fagoo validado com Postgres PGlite real, rotas HTTP de autenticação/MFA e verificação TypeScript. Os testes não enviaram mensagens por canais reais. O APK de bancada não foi publicado em Play Store/App Store, nem instalado em um aparelho escolhido pelo usuário nesta sessão.

## API

Públicas: `POST /api/pairing/start` com `client` (`vinki` ou `fagoo`) e `instance_name`; retorna `device_code`, `user_code`, `verification_uri`, `expires_in`, `interval`. `POST /api/pairing/token` usa `client` e `device_code`; pode retornar `authorization_pending`, `connected` ou erro `slow_down`, `expired_token`, `access_denied`, `invalid_grant`. Respeite o intervalo mínimo de cinco segundos.

Administrativas: `GET /api/v1/pairings`; `POST /api/v1/pairings/lookup` com `user_code`; `POST /api/v1/pairings/{id}/approve` com `profile_id`, `scopes`, `number_ids`, `pool_ids`, `bot_ids`; `POST /api/v1/pairings/{id}/deny`; `DELETE /api/v1/pairings/{id}`. A aplicação autenticada pode chamar `POST /api/v1/pairings/disconnect` para revogar seu próprio vínculo.

O fluxo usa a separação entre código de usuário e segredo do dispositivo descrita em [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628). As rotas são um contrato próprio, não um servidor OAuth genérico.
