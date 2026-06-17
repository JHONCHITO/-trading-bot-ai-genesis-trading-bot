# MT5 Bridge

Este EA conecta `Trading Bot AI` con MetaTrader 5 usando un archivo de señal en los Common Files de MQL5.

## Archivo de señal

El bot escribe en:

`%APPDATA%/MetaQuotes/Terminal/Common/Files/TradingBotAI/signal.json`

El EA lee:

`TradingBotAI\\signal.json`

usando `FILE_COMMON`.

## Instalacion

1. Abre MetaEditor desde MT5.
2. Crea un nuevo Expert Advisor llamado `TradingBotBridgeEA`.
3. Pega el contenido de `TradingBotBridgeEA.mq5`.
4. Compila.
5. Adjunta el EA al chart de `US30` o al símbolo equivalente de tu broker.
6. Activa `Algo Trading`.

## Uso

1. Ejecuta el bot con:

```bash
npm run analyze
```

2. El bot actualizará la señal para MT5.
3. El EA la leerá y ejecutará la orden si supera `MinConfidence`.

## Nota

Prueba primero en demo. Ajusta `Lots`, `MinConfidence` y el símbolo según la nomenclatura de tu broker.
