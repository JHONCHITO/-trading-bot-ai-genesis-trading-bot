# TradingBotBridgeEA

Este EA actua como puente profesional entre el motor Node.js y MetaTrader 5.

## Que hace

- lee `TradingBotAI\\signal.json` desde `FILE_COMMON`
- valida confianza, confluencia, vigencia y riesgo
- respeta filtro de noticias si existe `news.json`
- ejecuta ordenes de mercado
- gestiona posiciones abiertas con:
  - break-even
  - trailing stop
  - cierre parcial
- exporta un `market.json` enriquecido para el motor externo
- guarda estado y journal en Common Files

## Archivos principales

- `TradingBotBridgeEA.mq5`
- `TradingBotAI\\signal.json`
- `TradingBotAI\\market.json`
- `TradingBotAI\\news.json`
- `TradingBotAI\\state.json`
- `TradingBotAI\\journal.jsonl`

## Instalacion

1. Abre MetaEditor.
2. Crea o reemplaza el EA con `TradingBotBridgeEA.mq5`.
3. Compila.
4. Adjunta el EA al simbolo que quieras operar, por ejemplo `US30`.
5. Activa `Algo Trading`.

## Recomendacion de pruebas

Empieza en demo.

Antes de ir a real, verifica:

- que el broker permita trading algoritimico
- que el simbolo este habilitado
- que el spread no este fuera de control
- que las noticias no esten bloqueando la ventana de operacion

## Importante

En tu captura aparece el mensaje `trading has been disabled on server`.
Eso significa que el servidor/cuenta no esta permitiendo operar en ese momento.
Aunque el EA sea correcto, no va a abrir posiciones hasta que esa restriccion desaparezca.

## Compatibilidad

El EA sigue leyendo el formato de `signal.json` que escribe el bot de Node.js.
Si el bot envía `generatedAt` como ISO string o como tiempo numerico, el EA lo intenta interpretar.
