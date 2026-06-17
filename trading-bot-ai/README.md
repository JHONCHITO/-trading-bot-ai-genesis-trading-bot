# Trading Bot AI

Proyecto independiente, desde cero, para un bot de trading profesional.

Incluye:

- analisis de estructura de mercado,
- confluencia multi-timeframe,
- sesgo por sesion,
- filtro de noticias,
- journal de operaciones,
- IA adaptativa,
- capa opcional de revision con OpenAI,
- gestion de riesgo,
- paper trading,
- backtesting,
- walk-forward testing,
- exportacion de senales para MT5.

No depende de TOCHI Legal Suite.

## Uso rapido

```bash
npm install
npm run typecheck
npm run backtest
npm run walkforward
npm run analyze
```

## Modo analyze

Genera una lectura de mercado y, si hay setup, escribe la senal para MT5 en:

- `%APPDATA%/MetaQuotes/Terminal/Common/Files/TradingBotAI/signal.json`

Si `APPDATA` no existe, usa `state/mt5-signal.json`.

Si defines `OPENAI_API_KEY` en `.env`, `analyze` envia la propuesta a OpenAI como capa de revision. La respuesta ajusta suavemente la confianza y queda guardada en la senal como `openaiReview`.

Noticias y journal:

- `state/news.json` o `%APPDATA%/MetaQuotes/Terminal/Common/Files/TradingBotAI/news.json`
- `state/journal.jsonl`

Variables utiles:

- `OPENAI_API_KEY`
- `OPENAI_MODEL`
- `OPENAI_REVIEW_WEIGHT`
- `OPENAI_DISABLE_REVIEW`
- `OPENAI_STRICT_REVIEW`

## MT5

El archivo `mt5/TradingBotBridgeEA.mq5` es un Expert Advisor que lee la senal y ejecuta la orden en MetaTrader 5. Abrelo en MetaEditor, compilalo y colocarlo en el grafico de `US30` o el simbolo equivalente de tu broker.

## Filosofia

- sistema antes que intuicion,
- riesgo antes que ganancia,
- contexto antes que entrada,
- aprendizaje continuo con historial real.
