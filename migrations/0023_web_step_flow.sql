-- Passo web entregue como Flow nativo na linha oficial: o flow_token enviado
-- casa a resposta (content.type "flow_reply") com o passo que a originou.
ALTER TABLE web_steps ADD COLUMN flow_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS web_steps_flow_token ON web_steps(flow_token) WHERE flow_token IS NOT NULL;
