# Modo aparelho: fixação de tela e modo quiosque (Android)

O modo aparelho transforma um celular ou tablet em totem de senhas, painel de chamadas ou os dois. O PIN de saída
protege os botões do app (engrenagem, Voltar, desfazer o pareamento), mas não impede ninguém de usar os gestos do
sistema. Quem prende a tela no app é o Android, de uma de duas formas:

| | Instalação comum | App como *device owner* |
|---|---|---|
| Como entra | `startLockTask()` ao abrir a tela do papel | `setLockTaskPackages` + `startLockTask()`, sem perguntar |
| Pergunta a quem está diante do aparelho | Sim ("Fixar app?") | Não |
| Início e Recentes | Não saem do app | Não saem do app |
| Barras do sistema | Aparecem num deslize da borda, sem levar a outro app | Sem avisos nem informações do sistema |
| Ligar o modo | Fixação de apps ligada nos ajustes do sistema | `adb shell dpm set-device-owner …` num aparelho zerado |
| Como sai | Pelo app, depois do PIN, **ou** pelo gesto do sistema | Só pelo app, depois do PIN |
| Estado nos ajustes do aparelho | "Tela fixada" | "Modo quiosque ligado" |

O app lê o estado com `ActivityManager.getLockTaskModeState()` e mostra em **Ajustes deste aparelho → Trava da tela**
o que vale em cada caso. Código: `app/src/main/java/br/com/queven/wabotia/device/ui/DeviceLock.kt`.

## Quando a trava entra e sai

- **Entra** quando a tela do papel (Totem, Painel ou Híbrido) aparece. Na fixação comum, o pedido é feito uma vez por
  entrada nessa tela, para não perguntar de novo a cada segundo a quem recusou; nos ajustes há "Fixar agora". Como
  *device owner*, entra sempre que a tela volta ao primeiro plano.
- **Sai** (`stopLockTask()`) só depois do PIN: em "Desafixar a tela"/"Soltar a tela" nos ajustes (até voltar à tela do
  papel), ao desfazer o pareamento e ao sair da demonstração.
- Os ajustes abertos com o PIN continuam fixados, fecham sozinhos depois de 60 s sem toque e quando o app vai para
  segundo plano.
- A demonstração do modo aparelho não fixa a tela: quem experimenta (inclusive a revisão das lojas) sai livre.

## Instalação comum: fixação de tela

Sem permissão especial, o Android pergunta se a pessoa quer fixar o app. Quem configura o aparelho deve:

1. Ligar a fixação de apps nos ajustes do sistema, se o Android não perguntar:
   - **Samsung (One UI):** Configurações → Segurança e privacidade → Mais configurações de segurança → Fixar apps. Em
     versões antigas: Biometria e segurança → Outras configurações de segurança → Fixar janelas.
   - **Outros Android:** Configurações → Segurança (ou Segurança e privacidade) → Mais configurações de segurança →
     Fixação de app (no Android 9 a 11, Segurança → Avançado → Fixação de tela).
2. Ligar, na mesma tela, **"Pedir PIN antes de liberar"** (o aparelho precisa ter bloqueio de tela). Sem isso, o gesto
   do sistema desafixa sem pedir nada.
3. Abrir a tela do papel e tocar em **Fixar** na pergunta do Android.

Limites, que a tela de ajustes também explica:

- A fixação sai pelo gesto do sistema: tocar e segurar Voltar e Visão geral (navegação por botões) ou deslizar de baixo
  para cima e segurar (navegação por gestos). Com "Pedir PIN antes de liberar", esse gesto leva ao bloqueio de tela do
  aparelho, cujo PIN só a equipe deve saber.
- Quem está diante do aparelho pode recusar a pergunta "Fixar app?". Por isso o pedido acontece ao abrir a tela do
  papel, quando quem configura costuma estar presente.
- Reiniciar o aparelho solta a fixação, e o app não abre sozinho: abra o Vinki (ele vai direto para o modo
  aparelho) e confirme a fixação de novo.

## Modo quiosque: o app como *device owner*

Com o Vinki como administrador do aparelho (*device owner*), o pacote entra na lista de `setLockTaskPackages` e a
trava é silenciosa: sem pergunta, sem gesto do sistema e sem barra de status. O app **não** tem fluxo de
provisionamento; a configuração é manual, feita pelo suporte.

Por que há um receiver de administrador: `dpm set-device-owner` precisa de um componente `DeviceAdminReceiver`, e
`DevicePolicyManager.setLockTaskPackages` exige o `ComponentName` desse administrador (`isDeviceOwnerApp` sozinho não
precisaria). O app declara `device.WabotiaDeviceAdminReceiver` com `res/xml/device_admin.xml` sem nenhuma política,
protegido por `BIND_DEVICE_ADMIN`. Ele nunca pede para ser ativado: numa instalação comum fica inerte.

### Como configurar

1. **Zere o aparelho** (restauração de fábrica). O Android só aceita um *device owner* num aparelho sem contas: pule
   a conta Google e a conta Samsung no assistente inicial (ou remova todas as contas em Configurações → Contas).
2. Ative a depuração USB (Configurações → Sobre o telefone → Informações do software → toque 7 vezes em "Número de
   compilação"; depois Opções do desenvolvedor → Depuração USB).
3. Instale o Vinki (loja ou APK) e, num computador com o `adb`:

   ```
   adb shell dpm set-device-owner br.com.queven.wabotia/br.com.queven.wabotia.device.WabotiaDeviceAdminReceiver
   ```

   No build de depuração o pacote é `br.com.queven.wabotia.debug`:

   ```
   adb shell dpm set-device-owner br.com.queven.wabotia.debug/br.com.queven.wabotia.device.WabotiaDeviceAdminReceiver
   ```

   A resposta esperada começa com `Success: Device owner set to package`.
4. Desative a depuração USB, pareie o aparelho e escolha o papel. Os ajustes mostram "Modo quiosque ligado".

### Cuidados

- **Desfazer:** o app não tem botão para deixar de ser *device owner*, e o Android só aceita
  `adb shell dpm remove-active-admin …` para apps de teste (`testOnly`), o que o build de loja não é. O caminho
  garantido é a restauração de fábrica. Enquanto o app for administrador, o Android não deixa desinstalá-lo. Planeje o
  aparelho como dedicado ao totem ou ao painel.
- **Atualizações:** pela loja ou por APK assinado com a mesma chave; o *device owner* continua.
- **Tela inicial:** o app não se declara como tela inicial; depois de reiniciar, abra o Vinki (ou deixe-o abrir
  sozinho com o recurso de "app de inicialização" do fabricante, quando houver).
- **Energia:** o menu do botão liga/desliga continua disponível (padrão do Android para a trava).
- **Samsung Knox / MDM:** se o aparelho já é gerenciado por uma empresa, o *device owner* é o MDM; nesse caso,
  configure o quiosque pelo MDM e libere o pacote `br.com.queven.wabotia` lá.
- **Loja:** o receiver de administrador não pede política nenhuma; se a revisão da Google Play perguntar, ele existe
  só para o modo quiosque configurado por `adb`.
