import React from "react";
export function MaintenanceGuide() {
  return (
    <section
      className="account-setup hermes-guide"
      id="atualizacoes"
      aria-labelledby="updates-guide-title"
    >
      <div className="eyebrow">DEPOIS DA INSTALAÇÃO · MANUTENÇÃO</div>
      <h2 id="updates-guide-title">Atualize pelo painel</h2>
      <p>
        Em <strong>Sistema e atualizações</strong>, clique em{" "}
        <strong>Verificar atualização</strong>. Após a preparação inicial
        abaixo, o botão <strong>Atualizar Wabotia</strong> solicita a nova
        versão à Cloudflare. Aguarde “Atualização publicada e verificada” e
        clique em “Reabrir painel atualizado”.
      </p>
      <details>
        <summary>Preparação inicial do Cloudflare Builds</summary>
        <div className="guide-detail">
          <ol>
            <li>
              Abra seu Worker na Cloudflare e vá a{" "}
              <strong>Settings → Builds</strong>. Confirme o repositório da sua
              instalação e a branch <code>main</code>.
            </li>
            <li>
              Confirme que o arquivo <code>wabotia-build.mjs</code> existe na
              raiz desse repositório. Se sua cópia é antiga e nem mostra
              “Sistema e atualizações”, siga o{" "}
              <a
                href="https://github.com/Quevenapp/Wabotia/blob/main/docs/ATUALIZACOES.md"
                target="_blank"
                rel="noreferrer"
              >
                roteiro da primeira atualização
              </a>
              .
            </li>
            <li>
              Em Build configuration, defina <strong>Build command</strong>:{" "}
              <code>node wabotia-build.mjs</code>;{" "}
              <strong>Deploy command</strong>: <code>npm run deploy</code>.
            </li>
            <li>
              Em Variables and secrets de <strong>Builds</strong>, adicione{" "}
              <code>WABOTIA_UPDATE_ORIGIN</code> com o endereço HTTPS da sua
              instalação, sem <code>/app</code> no final. Exemplo:{" "}
              <code>https://meu-wabotia.minhaconta.workers.dev</code>.
            </li>
            <li>
              Crie um <strong>Deploy Hook</strong> para <code>main</code>. Copie
              a URL e cole no campo protegido de{" "}
              <strong>
                Sistema e atualizações → Configurar atualização pelo painel
              </strong>
              . Confirme os passos e salve.
            </li>
          </ol>
          <p>
            O hook é uma credencial. Guarde-o em local privado. GitHub Actions
            continua desativado. Essa opção depende do Cloudflare Builds;
            instalações publicadas somente pelo terminal precisam vincular seu
            repositório primeiro.
          </p>
        </div>
      </details>
      <details>
        <summary>A atualização ficou sem confirmação ou falhou?</summary>
        <div className="guide-detail">
          <p>
            Confira Deployments/Builds do seu Worker e abra o registro da
            publicação. Uma falha de rede pode ter ocorrido depois de a
            Cloudflare aceitar o pedido. O Wabotia não dispara outro
            automaticamente. Quando não houver build em execução nem na fila,
            marque a confirmação e libere uma nova tentativa. Essa opção é
            liberada após falha confirmada ou 15 minutos.
          </p>
          <p>
            Faça backup antes de atualizar. A publicação preserva nome, D1, R2,
            Durable Objects, domínios, variáveis e secrets. Mudanças que exigem
            novos recursos são interrompidas e precisam do procedimento manual.
            Sua cópia GitHub continua como origem do build; o código oficial é
            preparado no ambiente temporário de publicação.
          </p>
        </div>
      </details>
      <details>
        <summary>O botão Verificar atualização apresenta erro?</summary>
        <div className="guide-detail">
          <p>
            Versões antigas podem precisar de uma correção inicial pelo
            Cloudflare Builds. Siga o{" "}
            <a
              href="https://github.com/Quevenapp/Wabotia/blob/main/docs/ATUALIZACOES.md#recuperar-uma-versão-com-erro-ao-consultar-atualizações"
              target="_blank"
              rel="noreferrer"
            >
              passo a passo de recuperação
            </a>{" "}
            para publicar um commit oficial e preservar seus dados. Ao terminar,
            restaure o comando <code>node wabotia-build.mjs</code> para voltar a
            atualizar pelo painel.
          </p>
        </div>
      </details>
    </section>
  );
}
