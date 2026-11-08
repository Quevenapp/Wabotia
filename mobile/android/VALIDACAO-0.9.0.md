# Instalação Android 0.9.0 nos aparelhos conectados

Em 08/11/2026, foi executado `assembleDebug` com sucesso e o pacote existente foi atualizado com `adb install -r`, sem desinstalar nem limpar os dados dos aplicativos.

| Aparelho | Android | Versão anterior | Versão instalada | Verificação de abertura |
| --- | --- | --- | --- | --- |
| Samsung Galaxy A10s (SM-A107M) | 11 | 0.8.0-debug, código 1 | 0.9.0-debug, código 2 | Processo ativo e MainActivity em estado resumed; tela desligada e bloqueio do aparelho ativo impediram confirmar o desenho da tela. |
| Samsung Galaxy A07 (SM-A075M) | 16 | 0.8.0-debug, código 1 | 0.9.0-debug, código 2 | Abertura retornou `Status: ok`; MainActivity no primeiro plano. |
| Samsung tablet (SM-X230) | 16 | 0.8.0-debug, código 1 | 0.9.0-debug, código 2 | Abertura retornou `Status: ok`; MainActivity no primeiro plano. |

O pacote é `br.com.queven.wabotia.debug`. Os três aparelhos mantiveram a assinatura e a data da primeira instalação; a data de atualização e o código da versão foram conferidos. O buffer de falhas de aplicativos não apresentou registros durante esta verificação. O teste não enviou mensagens WhatsApp, não iniciou chamadas e não alterou o servidor configurado ou as sessões dos usuários.

Artefato: `app/build/outputs/apk/debug/app-debug.apk` (68.105.357 bytes).

SHA-256: `3afe8e52dcc7e91e7f40753bc4f61e6f414d6907403f78bd5b6c70fc83d3bb80`.

Esta foi uma atualização direta dos aparelhos, com o mesmo pacote de depuração já instalado; não houve publicação na Play Store.
