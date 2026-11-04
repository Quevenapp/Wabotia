#!/usr/bin/env python3
"""Rebuild the illustrated Portuguese installation guide using ReportLab."""
from pathlib import Path
from xml.sax.saxutils import escape
import shutil
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle, Flowable, KeepTogether
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.pagesizes import A4
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/pdf/wabotia-instalacao.pdf'; OUT.parent.mkdir(parents=True,exist_ok=True)
SHOTS=ROOT/'docs/screenshots'
font_root=Path('/usr/share/fonts/truetype/dejavu')
for name,file in [('Sans','DejaVuSans.ttf'),('SansBold','DejaVuSans-Bold.ttf'),('Mono','DejaVuSansMono.ttf'),('Serif','DejaVuSerif.ttf')]:
    pdfmetrics.registerFont(TTFont(name,str(font_root/file)))
pdfmetrics.registerFontFamily('Sans',normal='Sans',bold='SansBold',italic='Sans',boldItalic='SansBold')
GREEN=colors.HexColor('#173b30'); INK=colors.HexColor('#203b32'); MUTE=colors.HexColor('#62766b'); LIME=colors.HexColor('#d6ed9e'); CREAM=colors.HexColor('#f6f8f1'); LINE=colors.HexColor('#dfe6d7')
W,H=A4; M=44; CW=W-2*M
styles={
 'body':ParagraphStyle('body',fontName='Sans',fontSize=10.4,leading=15.2,textColor=INK,spaceAfter=9),
 'small':ParagraphStyle('small',fontName='Sans',fontSize=8.6,leading=12.1,textColor=MUTE,spaceAfter=7),
 'title':ParagraphStyle('title',fontName='SansBold',fontSize=26,leading=31,textColor=GREEN,spaceAfter=13),
 'sub':ParagraphStyle('sub',fontName='SansBold',fontSize=13.2,leading=18,textColor=GREEN,spaceBefore=8,spaceAfter=8),
 'eyebrow':ParagraphStyle('eyebrow',fontName='SansBold',fontSize=9,leading=13,textColor=MUTE,spaceAfter=10),
 'code':ParagraphStyle('code',fontName='Mono',fontSize=8.3,leading=12.4,textColor=GREEN,backColor=colors.HexColor('#edf2e3'),borderPadding=10,spaceBefore=5,spaceAfter=13),
 'caption':ParagraphStyle('caption',fontName='Sans',fontSize=8,leading=11,textColor=MUTE,spaceBefore=6,spaceAfter=13),
 'cover':ParagraphStyle('cover',fontName='SansBold',fontSize=39,leading=45,textColor=GREEN,spaceAfter=18),
}
story=[]
step_no=0
def p(text,style='body'): story.append(Paragraph(text,styles[style]))
def title(n,text):
    global step_no
    step_no=0
    if story:story.append(PageBreak())
    p(f'GUIA DE INSTALAÇÃO / {n:02d}', 'eyebrow');p(text,'title')
def sub(text):p(text,'sub')
def steps(items):
    global step_no
    for text in items:
        step_no+=1
        p(f'<b>{step_no}.</b> {text}')
def code(text):p(escape(text).replace('\n','<br/>').replace(' ','&#160;'),'code')
def box(text):
    t=Table([[Paragraph(text,styles['body'])]],colWidths=[CW]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#eaf2dc')),('BOX',(0,0),(-1,-1),0.6,LINE),('LEFTPADDING',(0,0),(-1,-1),13),('RIGHTPADDING',(0,0),(-1,-1),13),('TOPPADDING',(0,0),(-1,-1),11),('BOTTOMPADDING',(0,0),(-1,-1),5)]));story.extend([t,Spacer(1,12)])
def table(rows,widths=None):
    data=[[Paragraph(str(v),styles['small']) for v in row] for row in rows]
    t=Table(data,colWidths=widths or [CW*.33,CW*.67],hAlign='LEFT');t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),LIME),('VALIGN',(0,0),(-1,-1),'TOP'),('LINEBELOW',(0,0),(-1,-1),.4,LINE),('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),4)]));story.extend([t,Spacer(1,12)])
class Shot(Flowable):
    def __init__(self,name,width=CW,crop=None):
        Flowable.__init__(self);self.img=ImageReader(str(SHOTS/name));self.iw,self.ih=self.img.getSize();self.crop=crop or (0,0,self.iw,self.ih);self.width=width;self.height=width*self.crop[3]/self.crop[2];self.hAlign='CENTER'
    def draw(self):
        x,y,w,h=self.crop;s=self.width/w;c=self.canv;c.saveState();path=c.beginPath();path.rect(0,0,self.width,self.height);c.clipPath(path,stroke=0);c.drawImage(self.img,-x*s,(y+h-self.ih)*s,width=self.iw*s,height=self.ih*s);c.restoreState();c.setStrokeColor(LINE);c.rect(0,0,self.width,self.height,stroke=1,fill=0)
def shot(name,caption,width=CW,crop=None):story.extend([Shot(name,width,crop),Paragraph(caption,styles['caption'])])
def link(label,url):return f'<link href="{url}" color="#34684f"><u>{label}</u></link>'
# 1
p('WABOTIA / CÓDIGO ABERTO / VERSÃO 0.1.0','eyebrow')
p('Seu atendimento.<br/>Bem conectado.','cover')
p('Guia para instalar na Cloudflare,<br/>conectar o Hermes e preparar sua equipe.','sub')
shot('01-inicio.jpg','Página inicial do Wabotia. As ilustrações e conversas de exemplo são fictícias.',width=430)
p(link('Começar em wabotia.queven.app/install','https://wabotia.queven.app/install'))
p('Edição de 04/11/2026. Leia na ordem; escolha apenas um modo de WhatsApp por número. O painel fica na Cloudflare. Hermes e QR continuam no computador ou servidor que você escolher.','small')
# 2
title(2,'Antes de começar')
p('Você vai criar sua própria instalação. O site público é a porta de entrada para o guia e o código; seus atendimentos ficam nos recursos da sua conta Cloudflare.')
table([['Onde fica','O que faz'],['Cloudflare','Painel, API, contas, conversas, protocolos e arquivos privados. Workers + D1 + R2 + Durable Objects.'],['Hermes externo','Executa os bots, modelos e ferramentas já configurados. Pode estar em Linux, Windows/WSL2, macOS, Docker ou VPS.'],['Conector QR, se escolhido','Mantém a sessão WhatsApp em um processo externo. Precisa ficar ligado.'],['Cloudflare Tunnel + Access','Liga o Worker ao Hermes privado, com autenticação. Use quando a API não tem HTTPS acessível.']])
sub('Tenha em mãos')
steps(['Contas GitHub e Cloudflare. Considere Workers Paid para produção e habilite R2. Custos dependem do plano e do uso; modelos e canais são cobrados separadamente.','Hermes funcionando, com os perfis de bot que deseja usar. Preserve os bots e os dados existentes.','Um número de WhatsApp reservado ao teste e, se necessário, um bot Telegram novo e grupo privado com tópicos.','Um gerenciador de senhas. Guarde duas chaves aleatórias diferentes de 64 caracteres: <b>MASTER_KEY</b> e <b>SETUP_TOKEN</b>.'])
box('<b>Escolha o caminho:</b> botão na Cloudflare nas páginas 3-4, ou instalador pelo terminal na página 5. Ambos publicam o mesmo Wabotia. Não é preciso contratar VPS nem Supabase para o painel.')
p('MASTER_KEY protege suas credenciais; perder essa chave impede restaurá-las. SETUP_TOKEN autoriza a primeira conta. A senha do administrador é escolhida separadamente.','small')
# 3
title(3,'Publicar pelo botão')
steps([f'Abra {link("wabotia.queven.app/install","https://wabotia.queven.app/install")} e clique <b>Deploy to Cloudflare</b>. Faça login na sua conta.','Confira a origem <b>Quevenapp/Wabotia</b>. Escolha sua conta GitHub em <b>Git account</b> e um nome de projeto. Será criada uma cópia do código na conta escolhida.'])
shot('10-cloudflare-projeto.jpg','Tela real da Cloudflare, com nome fictício. Role dentro do formulário para ver os próximos campos.',width=450)
steps(['Use um banco D1 e um bucket R2 exclusivos desta instalação. Mantenha o bucket privado. Para uma segunda instalação, escolha recursos diferentes.','Preencha <b>MASTER_KEY</b> e <b>SETUP_TOKEN</b> com os valores que guardou. Não use os mesmos valores para produção e teste.'])
shot('11-cloudflare-secrets.jpg','Os dois campos ficam vazios nesta referência. Nunca publique uma captura com suas chaves.',width=410)
# 4
title(4,'Concluir o deploy')
shot('12-cloudflare-comandos.jpg','Mantenha os comandos detectados pelo repositório. O formulário foi conferido no Chrome.',width=450)
steps(['Em <b>Build command</b>, use <b>npm run build</b>. Em <b>Deploy command</b>, use <b>npm run deploy</b>: o comando publica o Worker e aplica as migrações D1.','Desative <b>Enable Preview builds</b> até preparar recursos isolados para testes. Nunca reutilize o banco de produção para experimentar mudanças.','Clique <b>Deploy</b> e aguarde a indicação de sucesso. Guarde a URL que termina em <b>workers.dev</b>.','No Worker, abra <b>Settings > Variables and Secrets</b>. Confira a existência de MASTER_KEY e SETUP_TOKEN. Se não foram solicitados, adicione ambos como <b>Secret</b>.','Abra a URL da <b>sua instalação</b>, acrescente <b>/app</b> e siga para a página 6.'])
box('<b>GitHub Actions:</b> o repositório original mantém Actions desativado. Na sua cópia, confira Settings > Actions > General > Disable actions. O botão usa Cloudflare Builds, que é outro serviço.')
p('O fluxo do botão reconheceu recursos, secrets e comandos. A publicação completa validada nesta versão foi feita por Wrangler. Se houver erro de R2, habilite o serviço na conta; se o build falhar, confira os comandos antes de tentar outra instalação.','small')
# 5
title(5,'Alternativa: instalador')
p('Este caminho gera as chaves automaticamente e foi validado com recursos reais na Cloudflare. Use-o se preferir acompanhar a instalação pelo terminal.')
steps(['Instale <b>Node.js LTS</b> (22.13 ou superior; prefira 24 LTS) e <b>Git</b> pelos sites oficiais.','Abra Terminal no Linux/macOS, Ubuntu no Windows/WSL2, ou PowerShell com Node e Git instalados. Cole uma linha de cada vez e pressione Enter.'])
code('git clone https://github.com/Quevenapp/Wabotia.git\ncd Wabotia\nnpm ci\nnpx wrangler login\nnpm run setup')
steps(['No navegador aberto pelo login, escolha a conta Cloudflare correta. Volte ao terminal após a confirmação.','Aguarde as cinco etapas: acesso, recursos, banco, secrets e endereço final. Não feche o processo antes da conclusão.','Na pasta Wabotia, abra <b>.secrets.production.local.json</b> em um editor. Arquivos iniciados por ponto podem estar ocultos. Guarde esse arquivo protegido e copie SETUP_TOKEN somente quando o painel pedir.','Abra a URL do Worker, com <b>/app</b> ao final. Siga para a página 6.'])
sub('Teste e domínio próprio')
code('npm run setup -- --environment staging\nnpm run setup -- --domain painel.seudominio.com')
p('Use a primeira linha para um ambiente de teste separado; a segunda, se quiser domínio próprio na mesma conta Cloudflare. Não execute o instalador sobre recursos existentes com uma nova MASTER_KEY. Preserve os arquivos .local.json da implantação.','small')
# 6
title(6,'Sua primeira conta')
p('Abra <b>SUA_URL/app</b>. A primeira conta é de administrador. As próximas pessoas serão cadastradas dentro do painel.')
shot('02-primeira-conta.jpg','Tela real de primeira instalação. Os campos foram mantidos vazios.',width=280,crop=(805,0,425,648))
steps(['Preencha nome, e-mail e senha com pelo menos 12 caracteres. Cole o <b>SETUP_TOKEN</b> gerado ou definido no deploy.','Clique <b>Criar conta e entrar</b>. Depois clique <b>Criar perfil de atendimento</b> ou no <b>+</b> ao lado do seletor de perfil. Dê um nome, como Atendimento da loja.','Mantenha o atendimento pausado. Em <b>Pessoas</b>, crie uma conta por atendente e selecione os perfis permitidos.'])
# 7
title(7,'Conecte o Hermes')
p('O Wabotia descobre os perfis pela API administrativa e executa bots pela API Server nativa. Um Hermes com apenas chat completions pode precisar de atualização compatível.')
shot('04-hermes.jpg','Conexões > Nova conexão > Hermes. URLs fictícias; tokens vazios.',width=340,crop=(443,30,555,585))
steps(['No Hermes, habilite <b>API_SERVER_ENABLED=true</b> e defina <b>API_SERVER_KEY</b> forte no perfil certo. Reinicie o gateway pelo método que já utiliza.','No Wabotia, informe URL HTTPS administrativa, URL da API, token administrativo, nome e chave do perfil. Salve.','Clique <b>Testar conexão</b> e <b>Descobrir bots</b>. Ative a conexão, habilite os bots desejados e selecione o Atendente em <b>Equipe Bot</b>.'])
p('Referência: API Server na porta 8642; backend administrativo na 9119. Confirme as portas reais. A descoberta verifica idempotência durável. Não use a porta de desenvolvimento do frontend Hermes.','small')
# 8
title(8,'Hermes privado: use túnel')
p('Se o Hermes está em localhost, numa rede privada ou atrás do roteador, o Worker precisa de uma ponte. Use Tunnel protegido por Access. HTTPS autenticado já acessível dispensa o túnel.')
code('node scripts/connect-hermes.mjs')
steps(['Execute na pasta Wabotia do computador que alcança o Hermes. Informe dois hostnames, por exemplo <b>hermes.seudominio.com</b> e <b>api-hermes.seudominio.com</b>, as portas e um nome novo para o túnel.','O assistente gera <b>connection.NOME.local.md</b> e <b>tunnel.NOME.local.yml</b>. Abra o primeiro arquivo e siga seus comandos. Ele não altera os bots.','Em Cloudflare Zero Trust > <b>Access > Applications</b>, crie uma aplicação Self-hosted para cada hostname, com política <b>Service Auth</b>.','Em <b>Access > Service Auth > Service Tokens</b>, crie um token e inclua-o nas duas políticas. Guarde Client ID e Client Secret.','Instale cloudflared pelo site oficial. Siga o arquivo gerado para fazer login, criar túnel e rotas DNS. No YAML, complete o UUID e o caminho das credenciais.','Inicie o túnel. No formulário Hermes do Wabotia, abra <b>Conexão protegida por Cloudflare Access</b> e preencha o Client ID/Secret. Teste.','Configure cloudflared como serviço com reinício automático. Preserve volumes no Docker e mantenha o computador ligado.'])
box('<b>Backend administrativo:</b> um processo headless compatível pode usar <b>hermes serve --host 127.0.0.1 --port 9119</b> e HERMES_DASHBOARD_SESSION_TOKEN no ambiente. Use só se a porta estiver livre. Não crie um segundo gateway nem desative a autenticação de um dashboard público.')
p('Um dashboard público com login/OAuth pode não aceitar Bearer de sessão. A integração precisa de uma API administrativa compatível. No Docker, exponha portas apenas no loopback do host ou use uma rede privada entre os contêineres.','small')
# 9
title(9,'WhatsApp: Meta direto')
p('Escolha este modo para receber a API oficial Meta diretamente no Worker. O Hermes é chamado pelas APIs nativas; não há plugin Wabotia nesse caminho.')
steps(['Na Meta, prepare a aplicação WhatsApp Business e um número de teste. Separe o token, <b>Phone Number ID</b>, <b>WABA ID</b> e <b>App Secret</b>.','No Wabotia, abra <b>Conexões > Nova conexão</b> e escolha <b>WhatsApp · API oficial Meta</b>. Informe o número com DDI, somente dígitos, e os dados da etapa anterior.','Crie um <b>Verify Token</b> aleatório e preencha o campo. Salve a conexão.','Copie o webhook exibido no cartão da conexão. Na aplicação Meta, cadastre essa URL e o mesmo Verify Token. Assine os eventos <b>messages</b>.','Clique <b>Testar conexão</b>, ative o canal e use somente destinatários de teste autorizados na Meta.','Teste uma mensagem, a resposta pelo painel e um anexo. Só depois prepare o número de produção.'])
code('https://SUA_URL/webhooks/meta/ID_DA_CONEXAO')
sub('Janela, consentimento e templates')
p('Fora da janela de atendimento de 24 horas, esta versão permite notificações de protocolo somente com consentimento e template <b>UTILITY aprovado</b>. O corpo deve ter <b>{{1}}</b> para protocolo e <b>{{2}}</b> para andamento. Configure nome e idioma em Menus e preferências.')
box('<b>Um número, um consumidor.</b> Antes de trocar entre Meta direto, QR ou Hermes, pause o antigo, pare o conector correspondente e confira as pendências em Entregas. Ative o novo modo somente depois da reconciliação.')
p('A confirmação perdida de um envio pode produzir estado unknown. Confira no canal antes de autorizar nova tentativa: ela pode duplicar uma mensagem já recebida.','small')
# 10
title(10,'QR direto ou WhatsApp Hermes')
sub('QR direto: processo ao lado do Hermes')
steps(['Crie uma conexão <b>WhatsApp · QR direto</b>. Informe o número. Salve e clique <b>Gerar chave do conector</b>. Guarde chave e ID da conexão.','No host que ficará ligado, abra <b>connectors/qr</b>. Copie .env.example para .env e preencha URL HTTPS, ID e chave. Instale e inicie:'])
code('cd connectors/qr\nnpm ci\nnpm start')
steps(['Ative a conexão. O QR aparece no cartão do painel. No WhatsApp do celular, abra <b>Aparelhos conectados</b> e leia o código.','Mantenha o processo ligado. Preserve <b>data/</b>, com sessão e diário; configure reinício e backup. Não precisa abrir portas de entrada nem túnel para esse conector.'])
p('Em Docker, após preencher .env nessa pasta, use <b>docker compose up -d --build</b>. Preserve o volume qr-data ao atualizar. Baileys é um cliente não oficial; o pareamento deve ser validado na sua conta.','small')
sub('WhatsApp que já está ligado no Hermes')
p('Mantenha Meta/QR configurados no Hermes e escolha <b>WhatsApp · pelo Hermes</b> no painel. Esse caminho precisa do transporte mínimo e da extensão compatível de entrada exclusiva no gateway.')
p('Com o gateway parado e o perfil copiado para backup, siga o README de <b>connectors/hermes</b>: conferir a revisão, testar o patch com git apply --check, instalar no perfil existente e habilitar wabotia_transport em in_process. Reinicie pelo processo que já utiliza.')
box('<b>Não misture os caminhos.</b> WhatsApp direto e Telegram direto dispensam esse plugin. A extensão do Hermes requer manutenção técnica e revalidação quando o gateway é atualizado; não aplique em outra revisão sem conferir compatibilidade.')
# 11
title(11,'Telegram para sua equipe')
shot('06-telegram.jpg','Nova conexão > Telegram. O grupo é fictício e o token não está preenchido.',width=320,crop=(443,54,555,540))
steps(['Crie um bot exclusivo no <b>@BotFather</b> com /newbot. Não reutilize o bot do gateway Hermes.','Crie um <b>grupo privado com tópicos</b>. Adicione o bot como administrador, com permissão de gerenciar tópicos e enviar mensagens e anexos.','Obtenha o ID numérico do grupo, geralmente -100...; o Bot API getUpdates pode mostrar esse ID antes de configurar o webhook.','No painel, informe token e grupo, salve, teste e clique <b>Ligar recebimento Telegram</b>. Ative a conexão. Em Menus e preferências, cole os IDs da conexão e do grupo.','Cada pessoa envia <b>/identificar</b> no grupo. Vincule o ID retornado à conta correta em Pessoas. Depois use <b>/presente</b>.'])
p('O Telegram conversa diretamente com o Worker. Não instala plugin no Hermes. Vincule apenas o ID verificado da pessoa; não use bots terceiros para acessar os dados do grupo.','small')
# 12
title(12,'Prepare os bots e os menus')
shot('05-bots.jpg','Equipe Bot com um perfil de demonstração. Os dados são fictícios.',width=CW)
steps(['Em <b>Equipe Bot</b>, habilite os perfis descobertos e selecione quem será o <b>Atendente</b>. Só habilite perfis cuja API_SERVER_KEY foi cadastrada.','Clique <b>Ação de especialista</b>. Escolha o bot, descreva quando consultá-lo e a ação permitida. Os modelos e ferramentas continuam configurados no Hermes.','Abra <b>Conhecimento</b> e cadastre informações úteis: texto, URL pública, PDF com texto ou DOCX. Espere a importação ficar disponível. Arquivos têm limite de 20 MB.','Em <b>Menus e preferências</b>, configure prazo, instruções, avaliações e opções de menu. Se necessário, use o editor JSON para aplicativos e submenus. JEV é opcional.','Cadastre pessoas e permissões por perfil. Em <b>Disponibilidade</b>, registre presença antes de abrir o atendimento.'])
box('<b>Arquivos de bots:</b> precisam ser exportados como artefatos da API nativa. Caminhos locais não viram links públicos. Downloads de uso único interrompidos exigem nova exportação; o Wabotia não os repete automaticamente.')
p('PDF digitalizado sem texto não tem OCR nesta versão. Vídeos precisam de legendas públicas/autorizadas; também é possível importar TXT, VTT ou SRT.','small')
# 13
title(13,'Faça a primeira conversa')
shot('07-conversa.jpg','Tela de atendimento com mensagens fictícias. Assumir invalida a resposta automática anterior.',width=CW)
steps(['Use um número de teste autorizado. Envie uma pergunta que possa ser respondida com o conhecimento cadastrado.','Abra a conversa e clique <b>Assumir</b>. Confira que o responsável é sua conta e responda pelo painel.','Teste nota interna, anexo, transferência e abertura de protocolo. Nota interna não deve ir ao cliente.','No Telegram, vá ao tópico da conversa e use /assumir antes de /responder. Confira o resultado também no painel.'])
table([['Comando Telegram','Uso'],['/presente ou /ausente','Registra disponibilidade.'],['/assumir e /responder texto','Assume a conversa e responde ao cliente.'],['/nota texto e /transferir ID','Registra nota interna e transfere para atendente autorizado.'],['/encerrar e /retomar','Conclui ou devolve o atendimento à automação.'],['/identificar e /ajuda','Mostra sua identidade ou a lista de comandos.']])
p('No modo por comando, texto comum vira nota interna. No modo direto, o responsável responde sem /responder conforme as regras do tópico. Confira esse comportamento com mensagens fictícias antes de usar.','small')
# 14
title(14,'Integre outros sistemas')
p('A API é para comunicação entre servidores. Seu programa usa uma chave própria e só opera os perfis, bots e ações autorizados.')
shot('08-api.jpg','API e integrações > Nova aplicação. Exemplo de seleção de permissões.',width=325,crop=(443,34,555,580))
steps(['Cadastre uma aplicação, escolha os perfis e marque as permissões necessárias. Selecione os bots que ela poderá executar.','Clique <b>Gerar chave</b>, escolha validade e copie o valor exibido para o backend do integrador. Para rotação, emita outra e depois revogue a antiga.','Abra <b>/api-docs</b> na sua instalação. Há OpenAPI 3.1 e exemplos em cURL, JavaScript e Python no repositório.','Cadastre um webhook HTTPS para eventos. Guarde o segredo HMAC e verifique assinatura, timestamp e ID do evento. O destinatário precisa deduplicar.'])
p('Escritas exigem Idempotency-Key. Bots retornam 202 e um ID para acompanhamento. Repetir a chave com outro corpo gera conflito; timeout não deve disparar uma nova execução automaticamente.','small')
# 15
title(15,'Backup e manutenção')
sub('Copiar seus dados')
steps(['Pause o atendimento e as entradas dos canais. Pare QR/transporte para não gravar durante a cópia. Preserve os diários.','Na pasta Wabotia, execute o comando. Use o arquivo de configuração da implantação correta.'])
code('node scripts/backup.mjs wrangler.production.local.json backup-seguro')
p('O backup inclui banco e mídias. Só considere concluído quando manifest.json tiver <b>complete: true</b>. Guarde a pasta protegida e a <b>MASTER_KEY original separadamente</b>. Depois retome os canais.')
sub('Restaurar em recursos novos')
p('Crie um D1 vazio e um R2 privado novo. Faça uma configuração local apontando para esses recursos, sem sobrescrever a produção. Então execute:')
code('node scripts/restore.mjs wrangler.restore.local.json backup-seguro --empty-target')
p('O script recusa banco preenchido. Configure a MASTER_KEY original, publique a mesma versão e teste dados e arquivos antes de mover o domínio. Pare a instalação antiga antes de ligar os mesmos canais na restaurada.')
sub('Diagnóstico')
code('node scripts/diagnose.mjs https://SUA_URL')
table([['Sintoma','O que conferir'],['Hermes offline','Processo, portas, túnel, Access, URLs e chaves de cada perfil.'],['401 / 403 / 404','Validade da chave, permissões, perfil e dono do recurso.'],['429','Respeite Retry-After e reduza a frequência.'],['unknown','Confira Hermes/canal e use Execuções ou Entregas para reconciliar.']])
# 16
title(16,'Antes de atender clientes')
p('O núcleo e a publicação já foram testados. Seus perfis e canais precisam passar por homologação com credenciais e destinatários autorizados. Não confunda uma tela de demonstração com um canal conectado.')
sub('Execute na sua instalação de teste')
steps(['Envie e receba texto e anexo em cada canal escolhido. Confira protocolo, prazo, consentimento, avaliações, presença, notas e transferência.','Peça uma resposta lenta ao bot e assuma no meio da execução. A resposta automática antiga não deve chegar ao cliente.','Desligue e religue Hermes, túnel e conector. O painel deve continuar acessível; confira a retomada e os estados sem confirmação.','Repita uma mensagem/webhook de teste. Confira deduplicação, assinatura e recuperação. Teste também uma chave expirada/revogada.','Valide backup e restauração antes de depender da instalação. Só então ative o atendimento para clientes.'])
box('<b>Evidência desta edição:</b> 27 testes em workerd, 3 testes Python do transporte, 20 verificações HTTP em staging, exemplos em três linguagens e restauração remota D1/FTS/R2. Os testes externos usaram simulações ou dados fictícios. <b>Meta, QR, Telegram e Hermes reais ainda não foram homologados nesta implantação.</b>')
sub('Onde encontrar os detalhes')
p(link('Site e guia atualizado','https://wabotia.queven.app/install'))
p(link('Código aberto e instruções completas','https://github.com/Quevenapp/Wabotia'))
p(link('Matriz de validação e limites','https://github.com/Quevenapp/Wabotia/blob/main/docs/VALIDACAO.md'))
p(link('Operação, atualização e recuperação','https://github.com/Quevenapp/Wabotia/blob/main/docs/OPERACAO.md'))
p('Uma organização por implantação. Fuso America/Sao_Paulo. O histórico antigo não é importado automaticamente. Telas capturadas em 04/11/2026; menus de fornecedores podem mudar. Wabotia é independente de Cloudflare, Meta, Telegram e NousResearch.','small')
def on_page(c,doc):
    c.setFillColor(CREAM);c.rect(0,0,W,H,fill=1,stroke=0)
    c.setFillColor(GREEN);c.rect(0,H-8,W,8,fill=1,stroke=0)
    c.setStrokeColor(LINE);c.line(M,39,W-M,39)
    c.setFont('Sans',8);c.setFillColor(MUTE);c.drawString(M,25,'WABOTIA  |  Instalação na Cloudflare  |  04/11/2026');c.drawRightString(W-M,25,f'{doc.page:02d}')
class NumberedCanvas(canvas.Canvas):
    def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);self.setTitle('Wabotia - Guia ilustrado de instalação');self.setAuthor('Quevenapp');self.setSubject('Instalação Cloudflare e conexão Hermes, WhatsApp, Telegram e API')
doc=SimpleDocTemplate(str(OUT),pagesize=A4,rightMargin=M,leftMargin=M,topMargin=43,bottomMargin=52,title='Wabotia - Guia de instalação',author='Quevenapp',allowSplitting=0)
doc.build(story,onFirstPage=on_page,onLaterPages=on_page,canvasmaker=NumberedCanvas)
public=ROOT/'public/guide/wabotia-instalacao.pdf';public.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(OUT,public)
print(OUT)
