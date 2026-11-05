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
p('WABOTIA / CÓDIGO ABERTO / VERSÃO 0.3.0','eyebrow')
p('Seu atendimento.<br/>Bem conectado.','cover')
p('Guia para instalar na Cloudflare,<br/>conectar o Hermes e preparar sua equipe.','sub')
shot('01-inicio.jpg','Página inicial do Wabotia. As ilustrações e conversas de exemplo são fictícias.',width=430)
p(link('Começar em wabotia.queven.app/install','https://wabotia.queven.app/install'))
p('Edição de 05/11/2026. Leia na ordem; escolha apenas um modo de WhatsApp por número. O painel fica na Cloudflare. Hermes e QR continuam no computador ou servidor que você escolher.','small')
# 2
title(2,'Um instalador. Sua Cloudflare.')
p('Você não precisa criar uma conta GitHub nem um repositório para instalar. O código aberto continua no repositório oficial. Sua instalação recebe versões prontas e pode ser atualizada pelo painel.')
steps(['Prepare a conta Cloudflare: Workers, R2 e D1. Para conectar um Hermes privado, ative também Zero Trust. Veja páginas 3 a 5.','Crie um token da API Cloudflare e copie seu Account ID. O token autoriza o instalador a criar os recursos na sua conta. Página 6.','Execute o instalador no computador uma vez. Ele baixa o pacote oficial, verifica a integridade, publica os recursos e gera as chaves. Página 7.','Guarde a pasta privada criada. Abra a URL exibida e use SETUP_TOKEN para criar seu administrador. Páginas 8 e 9.','Conecte o Hermes e os canais. Nas próximas versões, use Sistema e atualizações, páginas 33 e 34.'])
box('<b>Vai reinstalar?</b> Use um nome novo, como wabotia-atendimento. A instalação nova começa vazia e não importa o histórico antigo. Mantenha a anterior até conferir o novo painel. O roteiro de transição está na página 35.')
p('O computador usado para instalar pode ser desligado depois. Hermes, QR e cloudflared precisam permanecer ligados no local onde executam os bots e canais.','sub')
# Prerequisites, before deployment
title(3,'Para que serve a Cloudflare?')
p('Ela mantém o Wabotia disponível na internet e guarda seus dados. Cada serviço cuida de uma parte. O Hermes continua executando os bots na máquina ou VPS escolhida.')
table([['Serviço','Função no seu atendimento'],['Workers','Executa o painel web, a API e as regras do atendimento. O painel continua acessível com seu computador desligado.'],['D1','Banco de dados: guarda usuários, configurações, conversas, protocolos e registros.'],['R2','Armazena documentos, imagens, áudios e anexos. Um bucket é a área onde esses arquivos ficam guardados. Use bucket privado.'],['Durable Objects e alarmes','Organizam o processamento por perfil e retomam tarefas pendentes, mantendo a ordem e evitando operações duplicadas.'],['Zero Trust','Área da Cloudflare para administrar a proteção do acesso ao Hermes. Exige ativar um plano, como Zero Trust Free.'],['Access','Confere se a chamada ao Hermes vem do Wabotia autorizado. Usa aplicações, políticas Service Auth e um par Client ID/Secret.'],['Tunnel e cloudflared','Ligam a Cloudflare à máquina do Hermes sem abrir portas no roteador. cloudflared é o programa instalado nessa máquina.'],['DNS','Associa nomes como api-hermes.seudominio.com ao túnel correto. O domínio precisa estar ativo na Cloudflare.'],['API da Cloudflare','Recebe os arquivos do instalador e publica as atualizações solicitadas no painel, sem repositório próprio ou Builds.'],['Workers Secrets','Guardam MASTER_KEY e SETUP_TOKEN no ambiente protegido do Worker. Não publique esses valores no código.']],widths=[CW*.30,CW*.70])
box('<b>Exemplo:</b> a mensagem chega ao Worker; o registro vai para o D1 e o anexo para o R2. Durable Objects organizam o trabalho. Para executar um bot, o Worker passa por Access + Tunnel até o Hermes.')
p('O plano do site/domínio, Workers, a assinatura R2 e Zero Trust são configurações distintas. Ativar um deles não ativa automaticamente os demais. D1 e Durable Objects seguem o plano Workers.','small')
title(4,'Ative R2 e confira D1')
sub('R2: adesão necessária, mesmo com franquia gratuita')
steps(['Na conta Cloudflare da instalação, abra <b>Armazenamento e bancos de dados > R2 > Visão geral</b>.','Se aparecer a tela de adesão, conclua a ativação da assinatura R2. Preencha os dados de cobrança solicitados e confira termos e valores antes de confirmar. A franquia gratuita não dispensa essa adesão.','Confirme que aparece a lista de buckets ou <b>Criar bucket</b>. O instalador cria o bucket privado com o nome escolhido seguido de -media. Não é preciso criar um bucket antes.'])
p('R2 inclui uma franquia mensal gratuita e pode cobrar pelo uso excedente. Confira as condições atuais; gratuito não significa armazenamento ilimitado.','small')
sub('D1: banco incluído no plano Workers')
steps(['Abra <b>Armazenamento e bancos de dados > Banco de dados SQL D1</b>. Confira a lista e o botão <b>Criar banco de dados</b>.','O D1 já faz parte de <b>Workers Free e Paid</b>. Não há uma assinatura D1 separada equivalente à adesão do R2. Limites e eventuais cobranças seguem o plano Workers.','O instalador cria o banco exclusivo. Não é necessário criar um banco de teste antes. Se já instalou, confira <b>Worker > Bindings > DB</b> e preserve o banco existente.'])
sub('Confira o plano Workers')
p('Workers Paid é a referência de produção do Wabotia. Confira o plano e as condições na área de assinatura do Workers. Zero Trust Free e o plano do domínio não alteram essa assinatura.')
box('O deploy cria as ligações <b>DB</b> e <b>MEDIA</b> entre Worker, D1 e R2. Você não precisa gerar chaves D1 ou credenciais S3/R2 para preencher no Wabotia. Durable Objects e alarmes também são configurados pelo deploy.')
p(link('Ativação oficial do R2','https://developers.cloudflare.com/r2/get-started/')+' · '+link('Preços R2','https://developers.cloudflare.com/r2/pricing/')+' · '+link('Planos D1','https://developers.cloudflare.com/d1/platform/pricing/'),'small')
title(5,'Zero Trust e requisitos finais')
steps(['Para conectar Hermes privado, abra <b>Zero Trust > Controles de acesso > Aplicativos</b>. Se aparecer a apresentação, clique <b>Começar</b> e conclua a ativação do plano. Zero Trust Free atende esta configuração inicial.','Confira termos e eventuais informações de cobrança, mesmo escolhendo gratuito. Se pedir nome de equipe, escolha um disponível.','Confirme acesso a <b>Aplicativos</b> e <b>Credenciais de serviço</b>. Se já ativou, não repita a adesão. O Service Token, as políticas Access e o túnel serão criados depois, nas páginas 15 a 19.'])
sub('Antes de executar o instalador')
table([['Requisito','Como saber que está pronto'],['Node.js e npm','Node.js 22.13 ou superior instalado. O terminal reconhece node --version e npm --version.'],['Conta Cloudflare','Você tem acesso à conta de instalação e copiou o Account ID.'],['R2 ativado','Lista de buckets ou Criar bucket disponível.'],['D1 e Workers','D1 acessível e plano Workers escolhido. Produção usa Paid como referência.'],['Zero Trust e domínio','Aplicativos e Credenciais de serviço acessíveis. Domínio ativo para o túnel Hermes.']])
sub('As duas chaves são geradas automaticamente')
p('O instalador gera <b>MASTER_KEY</b> e <b>SETUP_TOKEN</b>, guarda ambas no Worker e no arquivo privado <b>chaves.local.json</b>. Você não precisa usar o gerador do site nesse caminho. MASTER_KEY protege as credenciais; SETUP_TOKEN libera o primeiro administrador.')
box('O token Cloudflare da próxima página é outra credencial: ele autoriza criar e atualizar recursos. Guarde a pasta privada do instalador. Não use a senha de login como chave.')
title(6,'Crie o token da instalação')
steps(['Abra a Cloudflare e selecione a conta da instalação. Copie seu <b>Account ID</b> na visão geral da conta. Ele também aparece como código de 32 caracteres na URL do dashboard, depois de dash.cloudflare.com/. Não use Zone ID.','Clique no ícone do usuário e abra <b>My Profile > API Tokens > Create Token</b>. Em <b>Custom Token</b>, clique <b>Get started</b>.','Dê um nome, como Wabotia instalação. Adicione as três permissões abaixo, todas do tipo <b>Account</b>.'])
table([['Permissão','Nível'],['Workers Scripts','Edit'],['D1','Edit'],['Workers R2 Storage','Edit']])
steps(['Em <b>Account Resources</b>, escolha <b>Include > Specific account</b> e somente a conta onde vai instalar. Defina a validade e confira o resumo.','Crie o token e copie o valor exibido uma vez. Guarde-o em um gerenciador de senhas até digitá-lo no instalador.'])
box('Não use Global API Key. O token será usado no seu computador e guardado como secret no seu Worker. Não é enviado ao site oficial. Para futuras atualizações, você pode trocá-lo por um token mais restrito, página 34.')
p('O token para preparar Access, Tunnel e DNS do Hermes é separado e usa as permissões da página 30.','small')
title(7,'Execute o instalador')
p('Instale Node.js LTS com npm pelo site nodejs.org. Abra um novo Terminal (Linux/macOS), Ubuntu/WSL2 ou PowerShell (Windows). Cole uma linha de cada vez e pressione Enter.')
sub('Linux, macOS ou WSL2')
code('curl -fL https://wabotia.queven.app/install-wabotia.mjs -o install-wabotia.mjs\nnode install-wabotia.mjs')
sub('Windows / PowerShell')
code('Invoke-WebRequest https://wabotia.queven.app/install-wabotia.mjs -OutFile install-wabotia.mjs\nnode .\\install-wabotia.mjs')
steps(['Informe seu <b>Account ID</b>. Depois cole o <b>token de API Cloudflare</b>. Por segurança, ele não aparece enquanto você digita ou cola. Pressione Enter.','Escolha um nome novo, em letras minúsculas e hífens, como <b>wabotia-atendimento</b>. Não reutilize o nome de uma instalação existente.','Aguarde as cinco etapas: baixar, publicar recursos, preparar banco, guardar chaves e confirmar a URL. Ao terminar, abra o endereço com <b>/app</b>.'])
box('O instalador roda uma vez. Ele não mantém um servidor no computador. A publicação e as próximas atualizações usam a API Cloudflare; não precisa vincular GitHub ou configurar Deploy Hook.')
p(link('Abrir o site para copiar os comandos','https://wabotia.queven.app/install#instalar'))
shot('20-instalacao-direta.jpg','No site, escolha seu sistema e copie os comandos. As chaves são geradas pelo instalador.',width=470,crop=(205,120,1035,405))
title(8,'Guarde a pasta e suas chaves')
p('Na pasta de onde você executou o comando, procure a nova pasta com o nome da instalação. Exemplo: wabotia-atendimento. Ela é privada; não envie para repositórios nem para suporte.')
table([['Arquivo ou pasta','Para que serve'],['chaves.local.json','Guarda MASTER_KEY, SETUP_TOKEN e o token Cloudflare de atualização. Abra em um editor de texto e copie somente o valor desejado.'],['installation.local.json','Identifica a conta, o Worker e o progresso. Permite retomar uma instalação interrompida.'],['wrangler.jsonc','Configuração de recuperação com os recursos da instalação.'],['worker, web e migrations','Cópia da versão instalada e migrações do banco. Não contêm um repositório Git.']])
steps(['Faça uma cópia protegida da pasta em um local de backup. Preserve MASTER_KEY: sem ela, as credenciais guardadas no banco não podem ser recuperadas.','Abra chaves.local.json. Copie o valor de SETUP_TOKEN, sem as aspas, para a primeira conta. Na página 9 você escolherá sua senha de login, que é diferente dessas chaves.'])
sub('Se a instalação parar')
p('Corrija o erro indicado e, na pasta onde está install-wabotia.mjs, retome com o mesmo nome e diretório:')
code('node install-wabotia.mjs --name wabotia-atendimento --resume')
p('Digite novamente a conta e um token válido. A retomada preserva as chaves existentes. Se escolheu outra pasta, acrescente --directory com o caminho correto.','small')
# 6
title(9,'Sua primeira conta')
p('Abra <b>SUA_URL/app</b>. A primeira conta é de administrador. As próximas pessoas serão cadastradas dentro do painel.')
shot('02-primeira-conta.jpg','Tela real de primeira instalação. Os campos foram mantidos vazios.',width=280,crop=(805,0,425,648))
steps(['Preencha nome, e-mail e senha com pelo menos 12 caracteres. Cole o <b>SETUP_TOKEN</b> do arquivo chaves.local.json.','Clique <b>Criar conta e entrar</b>. Depois clique <b>Criar perfil de atendimento</b> ou no <b>+</b> ao lado do seletor de perfil. Dê um nome, como Atendimento da loja.','Mantenha o atendimento pausado. Em <b>Pessoas</b>, crie uma conta por atendente e selecione os perfis permitidos.'])
# 7
title(10,'Hermes: por onde começar')
p('Se o Wabotia já está instalado, mantenha as chaves originais. Agora você vai ligar as APIs do Hermes, proteger a conexão na Cloudflare e cadastrar o perfil no painel.')
steps(['Escolha onde está o Hermes: <b>computador nativo</b> (páginas 11 e 12) ou <b>VPS Ubuntu com Docker</b> (páginas 13 e 14).','Teste as APIs localmente. Só continue depois dos dois resultados <b>OK</b>.','Você pode usar o <b>botão de deploy pelo painel, páginas 30 a 32</b>, ou configurar Zero Trust, Access e Tunnel manualmente nas páginas 15 a 19.','Cadastre a conexão no Wabotia, página 20. A página 21 explica como religar serviços.'])
sub('Cada chave tem um lugar')
table([['Credencial','Quem gera / onde usar'],['MASTER_KEY e SETUP_TOKEN','Gerador/instalador Wabotia. Secrets do Worker, já guardados na instalação. Preserve os valores originais.'],['Token administrativo Hermes','Assistente prepare-hermes.py. Campo administrativo da conexão no Wabotia.'],['API_SERVER_KEY de wabotia','Assistente ou Hermes. Campo da chave do perfil na conexão.'],['Access Client ID e Client Secret','Cloudflare. Preencha o par nos campos Cloudflare Access da conexão.'],['Token do túnel','Cloudflare. O assistente o guarda criptografado para gerar o instalador privado do cloudflared. No modo manual, use apenas na máquina.']])
box('As chaves Hermes geradas ficam em <b>~/.config/wabotia/hermes/chaves.local.txt</b>. Abra em um editor, copie apenas os valores e guarde o arquivo privado. No Linux, Ctrl+H mostra pastas ocultas. Não publique chaves nem capturas que as revelem.')
p(link('Comandos completos e referências oficiais','https://github.com/Quevenapp/Wabotia/blob/main/docs/HERMES-CLOUDFLARE.md'),'small')
# 8
title(11,'Local: habilite a API')
p('Abra Terminal no Ubuntu/Linux/macOS, ou Ubuntu no Windows/WSL2, com o mesmo usuário que instalou o Hermes. Confirme que <b>hermes --help</b> funciona. Não use sudo nos comandos Hermes.')
steps(['Se não tem uma cópia do código Wabotia, baixe-a. Se já tem, abra e atualize a pasta existente.'])
code('git clone https://github.com/Quevenapp/Wabotia.git\ncd Wabotia')
steps(['Execute a preparação abaixo. Troque <b>seudominio.com</b> pelo domínio ativo na sua Cloudflare. O perfil wabotia é criado somente se ainda não existir.'])
code('python3 scripts/prepare-hermes.py \\\n  --profile wabotia --create-profile \\\n  --admin-hostname hermes-local.seudominio.com \\\n  --api-hostname api-hermes-local.seudominio.com')
steps(['Aguarde as quatro etapas do assistente. Ele faz backup privado, preserva chaves existentes e cria as que faltam.','Abra o perfil <b>wabotia</b> no Hermes e confira modelo, provedor e autenticação. Se necessário, use o seletor nativo:'])
code('hermes -p wabotia model')
box('<b>API desligada:</b> a preparação configura gateway.api_server.enabled=true, host=127.0.0.1 e porta 8642. Criar a chave sozinho não inicia o processo. A próxima página liga os serviços.')
p('O gateway é compartilhado entre perfis. A chave default, necessária para o listener, permanece no Hermes; o Wabotia recebe somente a chave do perfil escolhido. Canais e dados existentes são preservados. O assistente recusa perfis pausados e gateway.multiplex_profiles=false.','small')
# 9
title(12,'Local: ligue e teste')
p('No Ubuntu/Linux com gateway instalado como serviço de usuário, cole uma linha de cada vez. A barra \\ no fim da linha indica continuação do mesmo comando.')
code('mkdir -p ~/.config/systemd/user\ninstall -m 600 \\\n  ~/.config/wabotia/hermes/hermes-wabotia-admin.service \\\n  ~/.config/systemd/user/hermes-wabotia-admin.service\nsystemctl --user daemon-reload\nsystemctl --user enable --now hermes-wabotia-admin.service\nsystemctl --user restart hermes-gateway.service')
p('Reinicie fora de um atendimento em andamento: o gateway pausa brevemente seus canais. Se aparecer <b>Unit not found</b>, use o gerenciador pelo qual seu Hermes já inicia. Não abra um segundo gateway. Sem gateway instalado, consulte <b>hermes gateway install --help</b>.','small')
sub('Confira o resultado antes de abrir o túnel')
code('python3 scripts/prepare-hermes.py --check')
code('OK · Descoberta: autenticado e recusando acesso sem chave.\nOK · API de bots: autenticado e recusando acesso sem chave.')
p('Esse teste confirma a descoberta, idempotência durável e autenticação. Não executa o modelo nem envia mensagens. Só prossiga quando as duas linhas estiverem OK.')
sub('Execução manual, Mac e persistência')
p('No macOS ou sem systemd, mantenha este comando em outro terminal. Reinicie o gateway pelo método já usado:')
code('python3 scripts/prepare-hermes.py --serve-admin')
p('Fechar o terminal encerra esse backend. No Mac, use launchd para início automático. No Ubuntu, para manter os serviços de usuário após sair da sessão:','small')
code('sudo loginctl enable-linger "$USER"')
p('No Windows/WSL2, systemd precisa estar habilitado e o WSL deve permanecer ligado. Suspender ou desligar o computador interrompe os bots.','small')
# 10
title(13,'VPS Docker: prepare')
p('Entre por SSH ou pelo terminal da Hostinger. Este roteiro usa a imagem oficial atual, usuário <b>hermes</b>, volume <b>/opt/data</b> e rede <b>host</b> no Ubuntu. Confira sua implantação antes de aplicar.')
code("docker ps --format 'table {{.Names}}\\t{{.Status}}'\ndocker inspect -f '{{.HostConfig.NetworkMode}}' hermes")
p('O exemplo usa contêiner chamado hermes. Substitua esse nome em todos os comandos se o seu for diferente. O segundo resultado precisa ser <b>host</b>. Em rede bridge, adapte a rede privada conforme o manual completo; o localhost do host não é o contêiner.','small')
steps(['Faça backup do volume e do Compose existentes. Não use docker compose down -v.','Na pasta do código Wabotia da VPS, copie e execute o assistente dentro do contêiner:'])
code('docker cp scripts/prepare-hermes.py \\\n  hermes:/tmp/wabotia-prepare-hermes.py\ndocker exec --user hermes hermes python3 \\\n  /tmp/wabotia-prepare-hermes.py \\\n  --output /opt/data/wabotia-connection \\\n  --profile wabotia --create-profile \\\n  --admin-hostname hermes-vps.seudominio.com \\\n  --api-hostname api-hermes-vps.seudominio.com\ndocker exec --user hermes hermes cp \\\n  /tmp/wabotia-prepare-hermes.py \\\n  /opt/data/wabotia-connection/prepare-hermes.py')
steps(['Fora de um atendimento, reinicie o contêiner existente para carregar a API:'])
code('docker restart hermes')
p('Confira modelo/provedor no perfil novo. Se a imagem não tiver o usuário, Python ou API compatível, revise a versão; não contorne as permissões executando tudo como root. A execução na sua VPS precisa ser validada.','small')
# 11
title(14,'VPS Docker: mantenha ligado')
p('Na VPS, crie <b>/etc/systemd/system/hermes-wabotia-admin.service</b> com sudo nano. O serviço abaixo mantém só o backend administrativo dentro do contêiner existente, sem iniciar outro gateway.')
code('[Unit]\nDescription=Hermes administrativo para Wabotia\nAfter=docker.service\nRequires=docker.service\n\n[Service]\nType=simple\nExecStart=/usr/bin/docker exec --user hermes hermes python3 \\\n  /opt/data/wabotia-connection/prepare-hermes.py \\\n  --output /opt/data/wabotia-connection --serve-admin\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=multi-user.target')
p('Confira <b>command -v docker</b> e ajuste o caminho se necessário. A porta 9119 precisa estar livre. Caso contrário, prepare com --admin-port 9120 e use 9120 também no túnel.','small')
code('sudo systemctl daemon-reload\nsudo systemctl enable --now hermes-wabotia-admin.service\ndocker exec --user hermes hermes python3 \\\n  /opt/data/wabotia-connection/prepare-hermes.py \\\n  --output /opt/data/wabotia-connection --check')
p('Espere os dois OK da página 12. Copie as chaves para um arquivo privado no host com os comandos do manual completo. Dentro do contêiner elas estão em <b>/opt/data/wabotia-connection/chaves.local.txt</b>.')
box('Instale cloudflared no host Ubuntu. Na rede host, ele alcança as APIs em 127.0.0.1. Use o túnel e os hostnames <b>da VPS</b>. Preserve o volume e o reinício automático do contêiner ao atualizar o Hermes.')
# 12
title(15,'Cloudflare: Zero Trust')
p('Se ativou Zero Trust nos requisitos iniciais, confira o acesso a Aplicativos e avance à próxima página. A referência abaixo orienta quem ainda precisa concluir a adesão. Use a conta com seu domínio ativo.')
shot('15-zero-trust-planos.jpg','Tela real de ativação do Zero Trust. Confira os valores e termos vigentes antes de concluir.',width=CW)
steps(['Se aparecer a tela de boas-vindas, clique <b>Começar</b>. Selecione o plano adequado. Zero Trust gratuito, quando disponível, atende esta conexão inicial.','Confira preço, eventuais dados de cobrança e termos antes de confirmar a ativação. O plano Zero Trust é separado do Workers Paid.','Se pedir nome de equipe, escolha um disponível, como minhaempresa-wabotia. O endereço nome.cloudflareaccess.com não é a URL do Hermes.','Volte a <b>Controles de acesso > Aplicativos</b>. Continue quando conseguir acessar a lista e adicionar aplicações.'])
box('A ativação precisa ser concluída pelo titular da conta quando houver aceite de termos ou cobrança. Ter um túnel já criado não significa que o Access esteja habilitado.')
# 13
title(16,'Access: proteja as duas URLs')
steps(['Abra <b>Controles de acesso > Credenciais de serviço > Service Tokens</b>. Em telas antigas: Access > Service Auth > Service Tokens.','Clique <b>Criar token de serviço</b>. Nome: wabotia-hermes-local. Escolha validade e anote a data de renovação.','A Cloudflare gera <b>Client ID</b> e <b>Client Secret</b>. Guarde os dois agora; o segredo pode aparecer apenas uma vez.','Em <b>Aplicativos > Adicionar aplicativo > Self-hosted</b>, preencha conforme a referência abaixo.'])
sub('Referência de preenchimento: aplicação administrativa')
table([['Campo','Preencher'],['Nome','Wabotia - Hermes administrativo local'],['Subdomínio / domínio','hermes-local / seudominio.com'],['Caminho do Access','Vazio: proteger o hostname inteiro'],['Nome da política','Somente Wabotia'],['Action / Ação','Service Auth'],['Include / Incluir','Service Token = wabotia-hermes-local']])
steps(['Salve a política e a aplicação. Não use Everyone ou Bypass.','Repita para <b>api-hermes-local.seudominio.com</b>, com o mesmo token. Na VPS, substitua local por vps nos nomes.','Confirme as duas aplicações e suas políticas antes de publicar as rotas do túnel.'])
box('Service Auth permite que o Worker se identifique sem uma pessoa no navegador. Uma política de login por e-mail não substitui essa autenticação. A tabela é um mapa dos campos, não uma captura de uma configuração já salva.')
# 14
title(17,'Tunnel: crie a ponte')
steps(['Abra <b>Rede > Túneis > Criar túnel</b>. Em algumas contas: Zero Trust > Networks > Connectors > Cloudflare Tunnels.','Escolha <b>Cloudflared</b>, se solicitado. Use um nome novo: wabotia-hermes-local; para VPS, wabotia-hermes-vps.','Na tela de instalação, selecione o sistema da máquina do Hermes. No Ubuntu, escolha o pacote/arquitetura corretos e instale pelos comandos oficiais exibidos.','Confirme a instalação no terminal:'])
code('cloudflared --version')
steps(['A tela fornece um comando para registrar o conector. Ele contém o <b>token do túnel</b>. Guarde esse token privado; não o cole nos campos do Wabotia.','Se não houver outro serviço cloudflared, o comando oficial de instalação de serviço pode ser usado. Se já houver, use o serviço separado da próxima página.','Aguarde o estado <b>Healthy / Íntegro</b>. Depois configure as rotas da página 19.'])
sub('Referência: o que cada nome significa')
table([['Nome','Uso'],['wabotia-hermes-local','Túnel novo para o computador local.'],['hermes-local.seudominio.com','Endereço HTTPS para descoberta de perfis.'],['api-hermes-local.seudominio.com','Endereço HTTPS para a API dos bots.'],['UUID.cfargotunnel.com','Destino DNS criado pela Cloudflare para o túnel.']])
box('Não execute outro <b>cloudflared service install</b> por cima de um conector existente. O token do túnel e o par Client ID/Secret do Access são credenciais diferentes. Não abra portas de entrada no roteador ou na VPS.')
# 15
title(18,'Um serviço de túnel separado')
p('Ubuntu/Linux/WSL2 com systemd: no Bash da máquina do Hermes, guarde o token sem exibi-lo no histórico. Cole <b>somente o token</b> quando solicitado. A entrada fica invisível; pressione Enter.')
code('mkdir -p ~/.config/wabotia/tunnel ~/.config/systemd/user\nchmod 700 ~/.config/wabotia/tunnel\nread -rsp "Token do novo túnel: " WABOTIA_TUNNEL_TOKEN\nprintf "%s" "$WABOTIA_TUNNEL_TOKEN" > \\\n  ~/.config/wabotia/tunnel/token\nunset WABOTIA_TUNNEL_TOKEN\nchmod 600 ~/.config/wabotia/tunnel/token\ncommand -v cloudflared')
p('Crie <b>~/.config/systemd/user/cloudflared-wabotia.service</b> no editor. Ajuste /usr/bin/cloudflared para o caminho mostrado acima. %h representa a pasta do usuário.','small')
code('[Unit]\nDescription=Cloudflare Tunnel exclusivo do Wabotia\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/bin/cloudflared tunnel --no-autoupdate run \\\n  --token-file %h/.config/wabotia/tunnel/token\nRestart=always\nRestartSec=5\nUMask=0077\n\n[Install]\nWantedBy=default.target')
code('systemctl --user daemon-reload\nsystemctl --user enable --now cloudflared-wabotia.service\nsudo loginctl enable-linger "$USER"')
p('No Mac/Windows nativo, siga o serviço oficial para esse sistema, preservando conectores existentes. Para teste temporário, cloudflared tunnel run --token-file CAMINHO_PRIVADO_DO_TOKEN mantém o túnel enquanto o terminal estiver aberto.','small')
# 16
title(19,'Rotas públicas e DNS')
p('No túnel, abra <b>Published application routes</b> (ou Public Hostnames) e adicione duas rotas. Use os mesmos hostnames já protegidos pelo Access. A tabela é referência de preenchimento.')
table([['Campo','Administrativo','Bots'],['Subdomínio','hermes-local','api-hermes-local'],['Domínio','seudominio.com','seudominio.com'],['Path no Tunnel','^/api/profiles$','^/p/wabotia/v1/.*$'],['Tipo','HTTP','HTTP'],['URL do serviço','127.0.0.1:9119','127.0.0.1:8642'],['HTTP Host Header','127.0.0.1:9119','Deixar padrão']],widths=[CW*.26,CW*.37,CW*.37])
steps(['Em <b>Additional application settings > HTTP Settings</b>, defina o HTTP Host Header administrativo. Isso permite a validação de Host do backend loopback; Access e Bearer continuam obrigatórios.','Salve as duas rotas. Na VPS, use hermes-vps e api-hermes-vps. Se mudou a porta administrativa, ajuste os dois campos da rota.','Em <b>Domínios > seu domínio > DNS > Registros</b>, confira os CNAMEs criados para UUID.cfargotunnel.com, com proxy ativo. Não substitua registros que já tenham outra função.','Abra uma rota protegida em janela anônima, sem chaves. O Access deve bloquear. Uma tela de login/recusa é esperada; a raiz / pode retornar 404.','Se aparecer JSON de perfis sem autenticação, remova a rota publicada e corrija a proteção antes de continuar. O teste autenticado será pelo Wabotia.'])
box('<b>Dois campos diferentes:</b> o caminho no Access ficou vazio para proteger o hostname inteiro. O Path do Tunnel limita as rotas publicadas. A API deste exemplo permite apenas o perfil wabotia. Não publique todas as páginas administrativas do Hermes.')
# 17
title(20,'Cadastre no Wabotia')
p('Na URL da sua instalação, abra <b>/app</b>. Crie um perfil de atendimento e vá a <b>Conexões > Nova conexão > Hermes</b>.')
shot('16-hermes-wabotia.jpg','Tela de referência do Wabotia, com dados fictícios e chaves vazias.',width=265,crop=(443,30,555,585))
table([['Campo','Preencher'],['URL administrativa','https://hermes-local.seudominio.com'],['URL dos bots','https://api-hermes-local.seudominio.com'],['Token administrativo','Token administrativo Hermes de chaves.local.txt'],['Perfil e API_SERVER_KEY','wabotia e sua chave de chaves.local.txt'],['Cloudflare Access','Abra os detalhes e cole Client ID + Client Secret']])
p('Use URLs base, sem /api/profiles ou /p/wabotia/v1. Salve, <b>Teste a conexão</b> e <b>Descubra bots</b>. Ative a conexão e escolha wabotia como Atendente em Equipe Bot. Mantenha o atendimento pausado até testar os canais.','small')
# 18
title(21,'Se desligou, como religar')
sub('Ubuntu nativo, com os serviços deste guia')
code('systemctl --user start hermes-gateway.service\nsystemctl --user start hermes-wabotia-admin.service\nsystemctl --user start cloudflared-wabotia.service\npython3 scripts/prepare-hermes.py --check')
p('Se desativou a API na configuração, repita a preparação da página 11 e depois <b>systemctl --user restart hermes-gateway.service</b>. O assistente preserva as chaves existentes.')
sub('Docker na VPS')
code('docker start hermes\nsudo systemctl restart hermes-wabotia-admin.service\nsystemctl --user start cloudflared-wabotia.service\ndocker exec --user hermes hermes python3 \\\n  /opt/data/wabotia-connection/prepare-hermes.py \\\n  --output /opt/data/wabotia-connection --check')
p('Se desativou a configuração da API, repita a preparação dentro do contêiner com o mesmo --output e reinicie hermes. Se usou o serviço cloudflared oficial, utilize seu nome correspondente.','small')
table([['Sintoma','Ação'],['Connection refused','Iniciar gateway/backend e conferir portas.'],['502 na Cloudflare','Túnel não alcança a API. Execute --check local.'],['1033 / túnel offline','Ligar cloudflared; conferir token e internet.'],['401/403 ou login HTML','Conferir chaves, validade e política Service Auth.'],['Invalid Host','HTTP Host Header = 127.0.0.1:9119.'],['Perfil não executa','Conferir modelo/provedor e chave do perfil.']])
p('Com dois OK locais e túnel Íntegro, volte ao Wabotia e teste a conexão. Computador/WSL precisam ficar ligados. O painel permanece disponível quando o Hermes está offline.','small')
# 9
title(22,'WhatsApp: Meta direto')
p('Escolha este modo para receber a API oficial Meta diretamente no Worker. O Hermes é chamado pelas APIs nativas; não há plugin Wabotia nesse caminho.')
steps(['Na Meta, prepare a aplicação WhatsApp Business e um número de teste. Separe o token, <b>Phone Number ID</b>, <b>WABA ID</b> e <b>App Secret</b>.','No Wabotia, abra <b>Conexões > Nova conexão</b> e escolha <b>WhatsApp · API oficial Meta</b>. Informe o número com DDI, somente dígitos, e os dados da etapa anterior.','Crie um <b>Verify Token</b> aleatório e preencha o campo. Salve a conexão.','Copie o webhook exibido no cartão da conexão. Na aplicação Meta, cadastre essa URL e o mesmo Verify Token. Assine os eventos <b>messages</b>.','Clique <b>Testar conexão</b>, ative o canal e use somente destinatários de teste autorizados na Meta.','Teste uma mensagem, a resposta pelo painel e um anexo. Só depois prepare o número de produção.'])
code('https://SUA_URL/webhooks/meta/ID_DA_CONEXAO')
sub('Janela, consentimento e templates')
p('Fora da janela de atendimento de 24 horas, esta versão permite notificações de protocolo somente com consentimento e template <b>UTILITY aprovado</b>. O corpo deve ter <b>{{1}}</b> para protocolo e <b>{{2}}</b> para andamento. Configure nome e idioma em Menus e preferências.')
box('<b>Um número, um consumidor.</b> Antes de trocar entre Meta direto, QR ou Hermes, pause o antigo, pare o conector correspondente e confira as pendências em Entregas. Ative o novo modo somente depois da reconciliação.')
p('A confirmação perdida de um envio pode produzir estado unknown. Confira no canal antes de autorizar nova tentativa: ela pode duplicar uma mensagem já recebida.','small')
# 10
title(23,'QR direto ou WhatsApp Hermes')
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
title(24,'Telegram para sua equipe')
shot('06-telegram.jpg','Nova conexão > Telegram. O grupo é fictício e o token não está preenchido.',width=320,crop=(443,54,555,540))
steps(['Crie um bot exclusivo no <b>@BotFather</b> com /newbot. Não reutilize o bot do gateway Hermes.','Crie um <b>grupo privado com tópicos</b>. Adicione o bot como administrador, com permissão de gerenciar tópicos e enviar mensagens e anexos.','Obtenha o ID numérico do grupo, geralmente -100...; o Bot API getUpdates pode mostrar esse ID antes de configurar o webhook.','No painel, informe token e grupo, salve, teste e clique <b>Ligar recebimento Telegram</b>. Ative a conexão. Em Menus e preferências, cole os IDs da conexão e do grupo.','Cada pessoa envia <b>/identificar</b> no grupo. Vincule o ID retornado à conta correta em Pessoas. Depois use <b>/presente</b>.'])
p('O Telegram conversa diretamente com o Worker. Não instala plugin no Hermes. Vincule apenas o ID verificado da pessoa; não use bots terceiros para acessar os dados do grupo.','small')
# 12
title(25,'Prepare os bots e os menus')
shot('05-bots.jpg','Equipe Bot com um perfil de demonstração. Os dados são fictícios.',width=CW)
steps(['Em <b>Equipe Bot</b>, habilite os perfis descobertos e selecione quem será o <b>Atendente</b>. Só habilite perfis cuja API_SERVER_KEY foi cadastrada.','Clique <b>Ação de especialista</b>. Escolha o bot, descreva quando consultá-lo e a ação permitida. Os modelos e ferramentas continuam configurados no Hermes.','Abra <b>Conhecimento</b> e cadastre informações úteis: texto, URL pública, PDF com texto ou DOCX. Espere a importação ficar disponível. Arquivos têm limite de 20 MB.','Em <b>Menus e preferências</b>, configure prazo, instruções, avaliações e opções de menu. Se necessário, use o editor JSON para aplicativos e submenus. JEV é opcional.','Cadastre pessoas e permissões por perfil. Em <b>Disponibilidade</b>, registre presença antes de abrir o atendimento.'])
box('<b>Arquivos de bots:</b> precisam ser exportados como artefatos da API nativa. Caminhos locais não viram links públicos. Downloads de uso único interrompidos exigem nova exportação; o Wabotia não os repete automaticamente.')
p('PDF digitalizado sem texto não tem OCR nesta versão. Vídeos precisam de legendas públicas/autorizadas; também é possível importar TXT, VTT ou SRT.','small')
# 13
title(26,'Faça a primeira conversa')
shot('07-conversa.jpg','Tela de atendimento com mensagens fictícias. Assumir invalida a resposta automática anterior.',width=CW)
steps(['Use um número de teste autorizado. Envie uma pergunta que possa ser respondida com o conhecimento cadastrado.','Abra a conversa e clique <b>Assumir</b>. Confira que o responsável é sua conta e responda pelo painel.','Teste nota interna, anexo, transferência e abertura de protocolo. Nota interna não deve ir ao cliente.','No Telegram, vá ao tópico da conversa e use /assumir antes de /responder. Confira o resultado também no painel.'])
table([['Comando Telegram','Uso'],['/presente ou /ausente','Registra disponibilidade.'],['/assumir e /responder texto','Assume a conversa e responde ao cliente.'],['/nota texto e /transferir ID','Registra nota interna e transfere para atendente autorizado.'],['/encerrar e /retomar','Conclui ou devolve o atendimento à automação.'],['/identificar e /ajuda','Mostra sua identidade ou a lista de comandos.']])
p('No modo por comando, texto comum vira nota interna. No modo direto, o responsável responde sem /responder conforme as regras do tópico. Confira esse comportamento com mensagens fictícias antes de usar.','small')
# 14
title(27,'Integre outros sistemas')
p('A API é para comunicação entre servidores. Seu programa usa uma chave própria e só opera os perfis, bots e ações autorizados.')
shot('08-api.jpg','API e integrações > Nova aplicação. Exemplo de seleção de permissões.',width=325,crop=(443,34,555,580))
steps(['Cadastre uma aplicação, escolha os perfis e marque as permissões necessárias. Selecione os bots que ela poderá executar.','Clique <b>Gerar chave</b>, escolha validade e copie o valor exibido para o backend do integrador. Para rotação, emita outra e depois revogue a antiga.','Abra <b>/api-docs</b> na sua instalação. Há OpenAPI 3.1 e exemplos em cURL, JavaScript e Python no repositório.','Cadastre um webhook HTTPS para eventos. Guarde o segredo HMAC e verifique assinatura, timestamp e ID do evento. O destinatário precisa deduplicar.'])
p('Escritas exigem Idempotency-Key. Bots retornam 202 e um ID para acompanhamento. Repetir a chave com outro corpo gera conflito; timeout não deve disparar uma nova execução automaticamente.','small')
# 15
title(28,'Backup e manutenção')
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
title(29,'Antes de atender clientes')
p('O núcleo e a publicação já foram testados. Seus perfis e canais precisam passar por homologação com credenciais e destinatários autorizados. Não confunda uma tela de demonstração com um canal conectado.')
sub('Execute na sua instalação de teste')
steps(['Envie e receba texto e anexo em cada canal escolhido. Confira protocolo, prazo, consentimento, avaliações, presença, notas e transferência.','Peça uma resposta lenta ao bot e assuma no meio da execução. A resposta automática antiga não deve chegar ao cliente.','Desligue e religue Hermes, túnel e conector. O painel deve continuar acessível; confira a retomada e os estados sem confirmação.','Repita uma mensagem/webhook de teste. Confira deduplicação, assinatura e recuperação. Teste também uma chave expirada/revogada.','Valide backup e restauração antes de depender da instalação. Só então ative o atendimento para clientes.'])
box('<b>Evidência desta edição:</b> 50 testes em workerd, 3 testes do atualizador, 3 testes Python do transporte, 20 verificações HTTP em staging, exemplos em três linguagens e restauração remota D1/FTS/R2. Os testes externos usaram simulações ou dados fictícios. <b>As APIs Hermes locais também passaram na descoberta e na recusa de acesso sem chave. Isso não substitui homologação completa de modelo, túnel e canais Meta, QR e Telegram na sua instalação.</b>')
sub('Onde encontrar os detalhes')
p(link('Site e guia atualizado','https://wabotia.queven.app/install'))
p(link('Código aberto e instruções completas','https://github.com/Quevenapp/Wabotia'))
p(link('Matriz de validação e limites','https://github.com/Quevenapp/Wabotia/blob/main/docs/VALIDACAO.md'))
p(link('Operação, atualização e recuperação','https://github.com/Quevenapp/Wabotia/blob/main/docs/OPERACAO.md'))
p('Uma organização por implantação. Fuso America/Sao_Paulo. O histórico antigo não é importado automaticamente. Telas capturadas em 04/11/2026; menus de fornecedores podem mudar. Wabotia é independente de Cloudflare, Meta, Telegram e NousResearch.','small')
# Novas opções de manutenção
title(30,'Autorize o deploy do Hermes')
p('Depois de ligar as APIs locais e obter dois OK, você pode criar Access, túnel e DNS pelo Wabotia. O Hermes continua no computador ou VPS. Quem já conectou esta máquina pode manter a conexão existente.')
steps(['Ative Zero Trust e confirme que o domínio está ativo na Cloudflare. As adesões a R2 e aos planos continuam sendo feitas pelo titular.','Abra <b>My Profile > API Tokens > Create Token > Custom Token</b>. Limite o token à conta e à zona do domínio desejado.','Na conta, conceda <b>Cloudflare Tunnel: Edit</b>, <b>Access: Apps and Policies: Edit</b> e <b>Access: Service Tokens: Edit</b>. Na zona, conceda <b>Zone: Read</b> e <b>DNS: Edit</b>. Defina validade e copie o token em local privado.','Na visão geral do domínio, copie <b>Account ID</b> e <b>Zone ID</b>.','No Wabotia, abra <b>Sistema e atualizações > Preparação do Hermes na Cloudflare</b>. Cole os dois IDs e o token. Clique <b>Verificar e salvar autorização</b>.'])
box('<b>Qual chave é esta?</b> É o token de API da Cloudflare, usado para criar os recursos. Ele é diferente de MASTER_KEY/SETUP_TOKEN, das duas chaves Hermes e do par Client ID/Secret do Access. O Wabotia o guarda criptografado.')
p('Se aparecer erro de autorização, confira conta, zona, validade e todas as permissões. Um token somente de leitura não pode executar o deploy.','small')
p(link('Roteiro completo do deploy pelo painel','https://github.com/Quevenapp/Wabotia/blob/main/docs/HERMES-CLOUDFLARE.md'),'small')
title(31,'Revise e faça o deploy')
shot('16-deploy-hermes.jpg','Conexões > Preparar Hermes na Cloudflare. Tela funcional com dados e chaves fictícios.',width=CW)
steps(['Informe dois subdomínios novos, perfil Hermes, portas e as duas chaves de chaves.local.txt. Confirme os pré-requisitos e clique <b>Revisar configuração</b>.','Confira o resumo e clique <b>Fazer deploy da configuração</b>. Acompanhe as 12 etapas. Endereços usados serão preservados e impedirão a criação.'])
p('A credencial Access gerada vale por um ano. Renove-a no Cloudflare e atualize a conexão antes de vencer. Não execute o assistente nos endereços de uma conexão já pronta.','small')
title(32,'Ligue o conector da máquina')
shot('17-conector-pronto.jpg','Ao concluir o deploy, baixe o conector para a máquina do Hermes. Exemplo fictício.',width=CW)
steps(['Instale cloudflared pelo site oficial, ou Docker para essa opção. Escolha o sistema e baixe o instalador. O arquivo contém uma credencial: guarde-o em local privado.','No terminal da máquina do Hermes, entre na pasta do download e rode o comando correspondente. Na VPS, transfira o arquivo de forma privada antes.'])
code('bash wabotia-conector-linux.sh')
p('Linux/WSL2 precisa de systemd. Docker requer Linux com rede do host. macOS/terminal precisa permanecer aberto. Na VPS, habilite sudo loginctl enable-linger "$USER". Depois, ative a conexão no painel, teste, descubra os bots e selecione o Atendente.','small')
title(33,'Atualize pelo painel')
shot('21-atualizacao-direta.jpg','Sistema e atualizações. Tela de referência da versão 0.3, sem credenciais.',width=CW)
steps(['O instalador já habilita a atualização. Entre como administrador e abra <b>Sistema e atualizações</b>. Faça backup antes de publicar uma nova versão.','Clique <b>Verificar atualização</b>. O painel consulta as versões oficiais publicadas; um commit no GitHub só fica disponível quando seu pacote é publicado.','Se houver uma versão nova, clique <b>Atualizar Wabotia</b>. O painel acompanha a preparação dos arquivos, as migrações e a publicação.','Espere <b>Atualização publicada e verificada</b>. Clique <b>Reabrir painel atualizado</b>. Banco, mídias, domínios e credenciais são preservados.'])
p('Você não precisa sincronizar uma cópia GitHub, configurar Builds nem criar Deploy Hook. A consulta é renovada a cada cinco minutos.','small')
title(34,'Renove o token quando precisar')
p('Se o token inicial expirar ou você quiser reduzir suas permissões, crie outro token na mesma conta Cloudflare. Depois da instalação, a atualização precisa somente de <b>Account > Workers Scripts > Edit</b>.')
steps(['Na Cloudflare, abra <b>My Profile > API Tokens > Create Token > Custom Token</b>. Adicione Workers Scripts: Edit e restrinja à conta da instalação.','No Wabotia, abra <b>Sistema e atualizações > Alterar configuração de atualização</b>.','Cole o token no campo protegido e clique <b>Verificar e salvar token</b>. O Wabotia confirma se o Worker é desta instalação antes de guardar a credencial criptografada.','Depois de confirmar o novo token, revogue o anterior na Cloudflare se ele não for usado por outro serviço. Atualize também sua cópia privada de chaves.local.json.'])
box('<b>Não troque MASTER_KEY para renovar o token.</b> Essa chave protege credenciais já guardadas no banco. O token de atualização e o token de deploy da configuração Hermes têm finalidades diferentes.')
sub('Onde ver o andamento')
p('Na Cloudflare, abra <b>Workers &amp; Pages > seu Worker > Deployments / Implantações</b>. A versão do Wabotia também aparece em <b>SUA_URL/api/health</b>. As novas instalações publicam diretamente, sem uma compilação em Builds.')
p(link('Documentação de atualização e recuperação','https://github.com/Quevenapp/Wabotia/blob/main/docs/ATUALIZACOES.md'))
title(35,'Reinstalação e recuperação')
sub('Sair de uma instalação antiga')
steps(['Faça backup do banco, arquivos e credenciais da instalação antiga se precisar preservar o histórico. A nova instalação começa vazia.','Execute o instalador com <b>outro nome</b>. Crie seu administrador e cadastre a conexão com o Hermes. Reutilize suas URLs, chaves e túnel existentes quando forem adequados.','Mantenha os canais da instalação nova pausados durante a preparação. Antes de transferir um número ou bot, pause a instalação antiga e confira as entregas pendentes.','Atualize os webhooks dos canais para a URL da nova instalação. Teste atendimento humano, bots e anexos antes de ativar. Nunca use dois consumidores ativos para o mesmo número.','Só depois de validar a nova instalação considere remover o Worker e os recursos antigos ou a cópia particular do GitHub. A nova instalação não depende deles.'])
sub('A atualização ficou sem confirmação')
p('Confira Implantações e /api/health. Um pedido pode ter sido aceito antes de a conexão cair. Não repita enquanto houver publicação em andamento. Após falha confirmada ou 15 minutos sem confirmação, o painel permite liberar nova tentativa, exigindo conferir que a anterior terminou.')
box('Não restaure apenas o código se uma migração exigir outro esquema de banco. Use o backup e revise a compatibilidade. O instalador não substitui outro Worker nem troca as chaves de uma instalação existente.')
p('O novo instalador foi exercitado em Linux com recursos reais na Cloudflare. Comandos Windows/macOS estão documentados; ainda precisam de validação nesses sistemas. Teste canais reais na sua instalação antes de usar em produção.','small')

def on_page(c,doc):
    c.setFillColor(CREAM);c.rect(0,0,W,H,fill=1,stroke=0)
    c.setFillColor(GREEN);c.rect(0,H-8,W,8,fill=1,stroke=0)
    c.setStrokeColor(LINE);c.line(M,39,W-M,39)
    c.setFont('Sans',8);c.setFillColor(MUTE);c.drawString(M,25,'WABOTIA  |  Instalação na Cloudflare  |  05/11/2026');c.drawRightString(W-M,25,f'{doc.page:02d}')
class NumberedCanvas(canvas.Canvas):
    def __init__(self,*args,**kwargs):super().__init__(*args,**kwargs);self.setTitle('Wabotia - Guia ilustrado de instalação');self.setAuthor('Quevenapp');self.setSubject('Instalação Cloudflare e conexão Hermes, WhatsApp, Telegram e API')
doc=SimpleDocTemplate(str(OUT),pagesize=A4,rightMargin=M,leftMargin=M,topMargin=43,bottomMargin=52,title='Wabotia - Guia de instalação',author='Quevenapp',allowSplitting=0)
doc.build(story,onFirstPage=on_page,onLaterPages=on_page,canvasmaker=NumberedCanvas)
public=ROOT/'public/guide/wabotia-instalacao.pdf';public.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(OUT,public)
print(OUT)
