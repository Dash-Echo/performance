# Echoenergia — Dashboard de Mídia Paga (com filtro de período)

Dashboard estático e interativo. Os dados diários dos últimos 90 dias estão
embutidos no `index.html`; o filtro de datas fatia tudo no navegador, sem backend.

## O que faz
- **Filtro de período:** escolha intervalo livre (De / Até) ou use atalhos
  (Ontem, 7d, 14d, 30d, 90d). Tudo recalcula na hora.
- **Tráfego do site (GA4):** sessões, usuários, novos usuários, sessões/usuário + evolução diária.
- **Mídia paga:** investimento, cliques, CPC, CPM, impressões (Google + Meta).
- **Google vs Meta:** gasto e cliques diários por plataforma + tabela comparativa
  (gasto, impressões, cliques, CPC, CPM, CTR, conversões, R$/conv).

## Fonte e granularidade
Dados via Windsor.ai (GA4 · Google Ads · Meta), base diária, 90 dias até 29/06/2026.
"Sempre baseado no que a plataforma fornece diariamente" — granularidade por dia.

## Conversões
A tabela comparativa usa o registro **diário do pixel** de cada plataforma
(granularidade por dia). É mais conservador que a conclusão de funil do GA4 —
o pixel do Google subcontabiliza leads. Para custo-por-lead "real", a referência é o GA4.

## Atualizar com dias novos
Os dados vão até a data em que o arquivo foi gerado. Para trazer dias novos,
é preciso regenerar o `index.html` (peça ao assistente, ou evolua para a versão
com Netlify Functions que busca do Windsor ao vivo).

## Deploy
Static site. Suba `index.html` no repositório e o Netlify republica sozinho.
