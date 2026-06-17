#property strict

#include <Trade/Trade.mqh>

input string SignalFileName = "TradingBotAI\\signal.json";
input double Lots = 0.01;
input ulong MagicNumber = 260615;
input double MinConfidence = 0.50;
input int DeviationPoints = 50;
input bool CloseOpposite = true;
input bool OnePositionPerSymbol = true;
input bool ExportMarketData = true;
input string MarketFileName = "TradingBotAI\\market.json";
input int MarketBars = 240;
input int TimerSeconds = 5;

CTrade trade;
string g_lastPayload = "";

string Trim(const string value)
{
   string result = value;
   StringTrimLeft(result);
   StringTrimRight(result);
   return result;
}

long ToUnixMs(datetime value)
{
   return (long)value * 1000;
}

string TimeframeToBotString(ENUM_TIMEFRAMES tf)
{
   switch(tf)
   {
      case PERIOD_M1:  return "M1";
      case PERIOD_M5:  return "M5";
      case PERIOD_M15: return "M15";
      case PERIOD_H1:  return "H1";
      default:         return "H1";
   }
}

string ReadCommonFile(const string fileName)
{
   int handle = FileOpen(fileName, FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
   {
      Print("No se pudo abrir el archivo: ", fileName, " error=", GetLastError());
      return "";
   }

   string text = "";
   while(!FileIsEnding(handle))
   {
      text += FileReadString(handle);
      if(!FileIsEnding(handle))
      {
         text += "\n";
      }
   }

   FileClose(handle);
   return text;
}

bool WriteMarketSnapshot()
{
   if(!ExportMarketData)
   {
      return true;
   }

   MqlRates rates[];
   int copied = CopyRates(_Symbol, _Period, 0, MarketBars, rates);
   if(copied <= 0)
   {
      Print("No se pudieron copiar velas del mercado. error=", GetLastError());
      return false;
   }

   ArraySetAsSeries(rates, true);
   int digits = (int)SymbolInfoInteger(_Symbol, SYMBOL_DIGITS);

   int handle = FileOpen(MarketFileName, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
   {
      Print("No se pudo abrir el archivo de mercado: ", MarketFileName, " error=", GetLastError());
      return false;
   }

   string json = "{\n";
   json += "\"symbol\":\"" + _Symbol + "\",\n";
   json += "\"timeframe\":\"" + TimeframeToBotString((ENUM_TIMEFRAMES)_Period) + "\",\n";
   json += "\"generatedAt\":" + IntegerToString(ToUnixMs(TimeCurrent())) + ",\n";
   json += "\"bars\":[\n";

   for(int i = copied - 1; i >= 0; i--)
   {
      json += "{";
      json += "\"timestamp\":" + IntegerToString(ToUnixMs(rates[i].time)) + ",";
      json += "\"open\":" + DoubleToString(rates[i].open, digits) + ",";
      json += "\"high\":" + DoubleToString(rates[i].high, digits) + ",";
      json += "\"low\":" + DoubleToString(rates[i].low, digits) + ",";
      json += "\"close\":" + DoubleToString(rates[i].close, digits) + ",";
      json += "\"volume\":" + IntegerToString((long)rates[i].tick_volume);
      json += "}";

      if(i > 0)
      {
         json += ",\n";
      }
   }

   json += "\n]\n}";
   FileWriteString(handle, json);
   FileClose(handle);
   return true;
}

string JsonGetString(const string json, const string key)
{
   string needle = "\"" + key + "\"";
   int pos = StringFind(json, needle);
   if(pos < 0)
   {
      return "";
   }

   pos = StringFind(json, ":", pos + StringLen(needle));
   if(pos < 0)
   {
      return "";
   }

   pos++;
   while(pos < StringLen(json) && StringGetCharacter(json, pos) <= 32)
   {
      pos++;
   }

   if(pos >= StringLen(json))
   {
      return "";
   }

   if(StringGetCharacter(json, pos) == '"')
   {
      pos++;
      int end = StringFind(json, "\"", pos);
      if(end < 0)
      {
         return "";
      }
      return StringSubstr(json, pos, end - pos);
   }

   int end = pos;
   while(end < StringLen(json))
   {
      ushort ch = StringGetCharacter(json, end);
      if(ch == ',' || ch == '}' || ch == '\n' || ch == '\r')
      {
         break;
      }
      end++;
   }

   return Trim(StringSubstr(json, pos, end - pos));
}

double JsonGetDouble(const string json, const string key, const double fallback = 0.0)
{
   string value = JsonGetString(json, key);
   if(value == "")
   {
      return fallback;
   }

   return StringToDouble(value);
}

int CountPositionsForSymbolAndSide(const string symbol, const long sideType)
{
   int total = 0;
   for(int index = PositionsTotal() - 1; index >= 0; index--)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0)
      {
         continue;
      }

      if(PositionSelectByTicket(ticket) &&
         PositionGetString(POSITION_SYMBOL) == symbol &&
         PositionGetInteger(POSITION_TYPE) == sideType)
      {
         total++;
      }
   }
   return total;
}

bool ClosePositionsForSymbolSide(const string symbol, const long sideType)
{
   bool ok = true;

   for(int index = PositionsTotal() - 1; index >= 0; index--)
   {
      ulong ticket = PositionGetTicket(index);
      if(ticket == 0)
      {
         continue;
      }

      if(!PositionSelectByTicket(ticket))
      {
         continue;
      }

      if(PositionGetString(POSITION_SYMBOL) != symbol)
      {
         continue;
      }

      if(PositionGetInteger(POSITION_TYPE) != sideType)
      {
         continue;
      }

      if(!trade.PositionClose(ticket))
      {
         ok = false;
         Print("No se pudo cerrar la posición ", ticket, " error=", GetLastError());
      }
   }

   return ok;
}

double NormalizeVolume(const string symbol, double volume)
{
   double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   if(step <= 0.0)
   {
      step = 0.01;
   }

   volume = MathMax(minVolume, MathMin(maxVolume, volume));
   volume = MathFloor(volume / step) * step;
   volume = NormalizeDouble(volume, 2);

   if(volume < minVolume)
   {
      volume = minVolume;
   }

   return volume;
}

bool PlaceSignalTrade(const string symbol, const string side, const double lots, const double stopLoss, const double takeProfit)
{
   if(!SymbolSelect(symbol, true))
   {
      Print("No se pudo seleccionar el símbolo: ", symbol);
      return false;
   }

   trade.SetExpertMagicNumber((long)MagicNumber);
   trade.SetDeviationInPoints(DeviationPoints);

   double volume = NormalizeVolume(symbol, lots);
   double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   double sl = NormalizeDouble(stopLoss, digits);
   double tp = NormalizeDouble(takeProfit, digits);

   if(side == "buy")
   {
      return trade.Buy(volume, symbol, ask, sl, tp, "TradingBotAI");
   }

   if(side == "sell")
   {
      return trade.Sell(volume, symbol, bid, sl, tp, "TradingBotAI");
   }

   Print("Señal desconocida: ", side);
   return false;
}

string ResolveTradeSymbol(const string requestedSymbol)
{
   if(requestedSymbol != "" && SymbolSelect(requestedSymbol, true))
   {
      return requestedSymbol;
   }

   if(_Symbol != "" && SymbolSelect(_Symbol, true))
   {
      if(requestedSymbol != "" && requestedSymbol != _Symbol)
      {
         Print("Símbolo de la señal no disponible: ", requestedSymbol, ". Usando el símbolo del gráfico: ", _Symbol);
      }
      return _Symbol;
   }

   return "";
}

void ProcessSignal()
{
   string payload = ReadCommonFile(SignalFileName);
   if(payload == "" || payload == g_lastPayload)
   {
      return;
   }

   string symbol = JsonGetString(payload, "symbol");
   string side = JsonGetString(payload, "side");
   StringToLower(side);
   double entry = JsonGetDouble(payload, "entry", 0.0);
   double stopLoss = JsonGetDouble(payload, "stopLoss", 0.0);
   double takeProfit = JsonGetDouble(payload, "takeProfit", 0.0);
   double confidence = JsonGetDouble(payload, "confidence", 0.0);

   if(symbol == "")
   {
      symbol = _Symbol;
   }

   symbol = ResolveTradeSymbol(symbol);
   if(symbol == "")
   {
      Print("No se pudo resolver un símbolo de trading válido.");
      return;
   }

   if(side != "buy" && side != "sell")
   {
      Print("Señal inválida o sin side válido.");
      return;
   }

   if(confidence < MinConfidence)
   {
      Print("Señal descartada por baja confianza: ", DoubleToString(confidence, 2));
      g_lastPayload = payload;
      return;
   }

   long oppositeType = side == "buy" ? POSITION_TYPE_SELL : POSITION_TYPE_BUY;
   long sameType = side == "buy" ? POSITION_TYPE_BUY : POSITION_TYPE_SELL;

   if(OnePositionPerSymbol)
   {
      if(CloseOpposite && CountPositionsForSymbolAndSide(symbol, oppositeType) > 0)
      {
         if(!ClosePositionsForSymbolSide(symbol, oppositeType))
         {
            Print("No se pudieron cerrar posiciones opuestas en ", symbol);
            return;
         }
      }

      if(CountPositionsForSymbolAndSide(symbol, sameType) > 0)
      {
         Print("Ya existe una posición del mismo lado en ", symbol, ". No se abre otra.");
         g_lastPayload = payload;
         return;
      }
   }

   if(entry <= 0.0 || stopLoss <= 0.0 || takeProfit <= 0.0)
   {
      Print("Señal incompleta. entry/SL/TP inválidos.");
      return;
   }

   if(PlaceSignalTrade(symbol, side, Lots, stopLoss, takeProfit))
   {
      g_lastPayload = payload;
      Print("Orden enviada correctamente para ", symbol, " lado=", side, " confianza=", DoubleToString(confidence, 2));
   }
   else
   {
      Print("Falló el envío de orden para ", symbol, " error=", GetLastError());
   }
}

int OnInit()
{
   EventSetTimer(TimerSeconds);
   WriteMarketSnapshot();
   Print("TradingBotBridgeEA iniciado. Leyendo señal desde FILE_COMMON: ", SignalFileName);
   Print("Exportando mercado a FILE_COMMON: ", MarketFileName);
   return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   WriteMarketSnapshot();
   ProcessSignal();
}