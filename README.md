# Echoenergia — Dashboard de Mídia Paga (30 dias)

Dashboard estático comparando **Google Ads** e **Meta** com dados dos últimos 30 dias,
extraídos via **Windsor.ai** (GA4 · Google Ads · Meta).

## O que mostra
- KPIs do período (investimento, conversões de funil, custo/conversão, impressões)
- Canais lado a lado: gasto, CTR, CPM e eficiência clique × conversão
- **Share de budget × share de retorno** (o descasamento central)
- **Canal com mais espaço de escala** (índice retorno ÷ budget)
- Tabela comparativa com os dados brutos

## Nota metodológica
- Conversões = conclusão real de funil medida no **GA4** por canal de origem da sessão
  (não o clique/conversão de pixel da plataforma).
- **ROAS monetário não disponível:** nenhuma conta tem valor de receita configurado
  nas conversões. Sendo uma operação de geração de lead, "retorno" é lido em volume e
  custo de conversão, não em faturamento.

## Stack
HTML + CSS + Chart.js (via CDN). Sem build step.

## Rodar local
Abra `index.html` no navegador, ou:
```
npx serve .
```

## Deploy
Configurado para Netlify via `netlify.toml` (publica a raiz). Veja instruções no chat.
