-- Texto da proposta do bot montado no servidor (src/bot-actions/describe.ts):
-- o que a pessoa ou o cliente confirma. `summary` continua com o texto do
-- modelo, mostrado à parte como não conferido.
ALTER TABLE bot_proposals ADD COLUMN description TEXT;
