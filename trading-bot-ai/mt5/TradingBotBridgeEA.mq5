#property strict

#include <Trade/Trade.mqh>

//============================================================
// TradingBotBridgeEA
// MT5 executor bridge for the Node.js trading engine.
//
// Design goals:
// - Read signals from FILE_COMMON
// - Export rich market snapshots back to FILE_COMMON
// - Validate signal freshness and risk
// - Execute market orders only when all gates pass
// - Manage open positions with break-even, trailing and partials
// - Persist bot state across restarts
// - Keep the EA deterministic and easy to audit
//============================================================

input string SignalFileName = "TradingBotAI\\signal.json";
input string MarketFileName  = "TradingBotAI\\market.json";
input string StateFileName   = "TradingBotAI\\state.json";
input string NewsFileName    = "TradingBotAI\\news.json";
input string JournalFileName = "TradingBotAI\\journal.jsonl";

input ulong  MagicNumber              = 260615;
input int    TimerSeconds             = 5;
input int    MarketBars               = 400;
input int    MaxSignalAgeMinutes      = 90;
input int    DeviationPoints          = 50;
input double MinConfidence            = 0.55;
input double MinConfluence            = 0.55;
input bool   ExportMarketData         = true;
input bool   UseNewsFilter            = true;
input int    NewsBeforeMinutes        = 30;
input int    NewsAfterMinutes         = 30;
input bool   UseRiskSizing            = true;
input double FixedLots                = 0.01;
input double RiskPercent              = 1.0;   // % of equity per trade
input double MaxSpreadPoints          = 300.0;
input double MaxDailyLossPct          = 2.0;
input double MaxDrawdownPct           = 8.0;
input bool   CloseOpposite            = true;
input bool   OnePositionPerSymbol     = true;
input int    MaxPositionsPerSymbol    = 1;
input bool   ManageOpenPositionsEnabled = true;
input bool   UseBreakEven             = true;
input int    BreakEvenTriggerPoints   = 450;
input int    BreakEvenPlusPoints      = 25;
input bool   UseTrailingStop          = true;
input int    TrailingStartPoints      = 650;
input int    TrailingDistancePoints   = 320;
input int    TrailingStepPoints       = 40;
input bool   UsePartialClose          = true;
input double PartialClosePercent      = 50.0;
input int    PartialCloseTriggerPoints = 800;
input bool   RespectTradeSession      = true;
input int    SessionStartHour         = 0;
input int    SessionEndHour           = 23;

CTrade trade;

//============================================================
// Runtime state
//============================================================

struct BotState
{
   datetime dayStart;
   datetime lastSignalAt;
   string   lastSignalHash;
   string   lastSignalId;
   double   dayStartEquity;
   double   peakEquity;
   double   dayPnL;
   int      tradesToday;
   int      blockedToday;
   bool     halted;
   string   haltReason;
};

struct SignalSnapshot
{
   string   raw;
   string   hash;
   string   signalId;
   string   symbol;
   string   side;
   double   entry;
   double   stopLoss;
   double   takeProfit;
   double   confidence;
   double   confluenceScore;
   string   regime;
   datetime generatedAt;
   int      ageMinutes;
   bool     valid;
   string   reason;
};

struct MarketStats
{
   string   symbol;
   ENUM_TIMEFRAMES timeframe;
   datetime generatedAt;
   double   bid;
   double   ask;
   double   spreadPoints;
   double   emaFast;
   double   emaSlow;
   double   atr;
   double   rsi;
   double   adx;
   double   volumeRatio;
   double   support;
   double   resistance;
   double   trendScore;
   double   volatilityScore;
   bool     bosUp;
   bool     bosDown;
   bool     chochUp;
   bool     chochDown;
   bool     sweepHigh;
   bool     sweepLow;
   bool     fvgUp;
   bool     fvgDown;
   string   bias;
};

struct PositionRuntime
{
   ulong    ticket;
   string   symbol;
   long     type;
   double   volume;
   double   openPrice;
   double   currentPrice;
   double   profitPoints;
   double   floatingPnl;
   bool     beDone;
   bool     partialDone;
};

BotState g_state;
string   g_lastMarketHash = "";

//============================================================
// Basic string / file helpers
//============================================================

string TrimValue(string value)
{
   StringTrimLeft(value);
   StringTrimRight(value);
   return value;
}

string ToLowerValue(string value)
{
   StringToLower(value);
   return value;
}

string BoolToJson(const bool value)
{
   return value ? "true" : "false";
}

string DoubleToJson(const double value, const int digits = 6)
{
   return DoubleToString(value, digits);
}

string LongToJson(const long value)
{
   return IntegerToString(value);
}

ulong Fnv1a64(const string text)
{
   uchar bytes[];
   const int len = StringToCharArray(text, bytes, 0, WHOLE_ARRAY, CP_UTF8);
   ulong hash = 1469598103934665603ULL;
   for(int i = 0; i < len; i++)
   {
      hash ^= (ulong)bytes[i];
      hash *= 1099511628211ULL;
   }
   return hash;
}

string HashText(const string text)
{
   return LongToJson((long)Fnv1a64(text));
}

bool FileExistsCommon(const string fileName)
{
   return FileIsExist(fileName, FILE_COMMON);
}

string ReadCommonText(const string fileName)
{
   int handle = FileOpen(fileName, FILE_READ | FILE_TXT | FILE_COMMON | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
   {
      return "";
   }

   string text = "";
   while(!FileIsEnding(handle))
   {
      text += FileReadString(handle);
      if(!FileIsEnding(handle))
         text += "\n";
   }

   FileClose(handle);
   return text;
}

bool WriteCommonText(const string fileName, const string text)
{
   int handle = FileOpen(fileName, FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
   {
      Print("No se pudo abrir para escritura: ", fileName, " error=", GetLastError());
      return false;
   }

   FileWriteString(handle, text);
   FileClose(handle);
   return true;
}

bool AppendCommonText(const string fileName, const string text)
{
   int handle = FileOpen(fileName, FILE_READ | FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_ANSI, 0, CP_UTF8);
   if(handle == INVALID_HANDLE)
   {
      handle = FileOpen(fileName, FILE_WRITE | FILE_TXT | FILE_COMMON | FILE_ANSI, 0, CP_UTF8);
      if(handle == INVALID_HANDLE)
      {
         Print("No se pudo crear journal: ", fileName, " error=", GetLastError());
         return false;
      }
   }

   FileSeek(handle, 0, SEEK_END);
   FileWriteString(handle, text + "\n");
   FileClose(handle);
   return true;
}

//============================================================
// JSON extraction helpers
//============================================================

int FindKeyPosition(const string json, const string key)
{
   const string needle = "\"" + key + "\"";
   return StringFind(json, needle);
}

string ExtractRawValue(const string json, const string key)
{
   const int posKey = FindKeyPosition(json, key);
   if(posKey < 0)
      return "";

   int pos = StringFind(json, ":", posKey);
   if(pos < 0)
      return "";

   pos++;
   while(pos < StringLen(json))
   {
      const ushort ch = (ushort)StringGetCharacter(json, pos);
      if(ch > 32)
         break;
      pos++;
   }

   if(pos >= StringLen(json))
      return "";

   const ushort first = (ushort)StringGetCharacter(json, pos);
   if(first == '"')
   {
      pos++;
      const int end = StringFind(json, "\"", pos);
      if(end < 0)
         return "";
      return StringSubstr(json, pos, end - pos);
   }

   int end = pos;
   int depth = 0;
   while(end < StringLen(json))
   {
      const ushort ch = (ushort)StringGetCharacter(json, end);
      if(ch == '{' || ch == '[')
         depth++;
      else if(ch == '}' || ch == ']')
      {
         if(depth <= 0)
            break;
         depth--;
      }
      else if(depth == 0 && (ch == ',' || ch == '\n' || ch == '\r'))
         break;
      end++;
   }

   return TrimValue(StringSubstr(json, pos, end - pos));
}

string JsonString(const string json, const string key, const string fallback = "")
{
   const string raw = ExtractRawValue(json, key);
   return raw == "" ? fallback : raw;
}

double JsonNumber(const string json, const string key, const double fallback = 0.0)
{
   const string raw = ExtractRawValue(json, key);
   if(raw == "")
      return fallback;
   return StringToDouble(raw);
}

bool JsonBool(const string json, const string key, const bool fallback = false)
{
   const string raw = ToLowerValue(TrimValue(ExtractRawValue(json, key)));
   if(raw == "true")
      return true;
   if(raw == "false")
      return false;
   return fallback;
}

datetime JsonDatetimeMs(const string json, const string key, const datetime fallback = 0)
{
   const double raw = JsonNumber(json, key, (double)fallback);
   if(raw <= 0)
      return fallback;
   return (datetime)(raw / 1000.0);
}

datetime ParseFlexibleDateTime(const string rawValue)
{
   string value = TrimValue(rawValue);
   if(value == "")
      return 0;

   bool numeric = true;
   for(int i = 0; i < StringLen(value); i++)
   {
      const ushort ch = (ushort)StringGetCharacter(value, i);
      if((ch < '0' || ch > '9') && ch != '.' && ch != '-')
      {
         numeric = false;
         break;
      }
   }

   if(numeric)
   {
      const double n = StringToDouble(value);
      if(n > 1000000000000.0)
         return (datetime)(n / 1000.0);
      if(n > 1000000000.0)
         return (datetime)n;
      return (datetime)n;
   }

   string normalized = value;
   StringReplace(normalized, "T", " ");
   StringReplace(normalized, "Z", "");
   const int dot = StringFind(normalized, ".");
   if(dot >= 0)
      normalized = StringSubstr(normalized, 0, dot);

   const datetime parsed = StringToTime(normalized);
   return parsed > 0 ? parsed : 0;
}

string JsonArraySection(const string json, const string key)
{
   const int posKey = FindKeyPosition(json, key);
   if(posKey < 0)
      return "";

   int pos = StringFind(json, "[", posKey);
   if(pos < 0)
      return "";

   int depth = 0;
   for(int i = pos; i < StringLen(json); i++)
   {
      const ushort ch = (ushort)StringGetCharacter(json, i);
      if(ch == '[')
         depth++;
      else if(ch == ']')
      {
         depth--;
         if(depth == 0)
            return StringSubstr(json, pos, i - pos + 1);
      }
   }

   return "";
}

int CountOccurrences(const string text, const string token)
{
   if(text == "" || token == "")
      return 0;

   int count = 0;
   int pos = 0;
   while(true)
   {
      pos = StringFind(text, token, pos);
      if(pos < 0)
         break;
      count++;
      pos += StringLen(token);
   }
   return count;
}

//============================================================
// State persistence
//============================================================

datetime TodayKey()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   dt.hour = 0;
   dt.min = 0;
   dt.sec = 0;
   return StructToTime(dt);
}

void ResetStateForNewDay()
{
   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_state.dayStart = TodayKey();
   g_state.dayStartEquity = equity;
   g_state.peakEquity = MathMax(g_state.peakEquity, equity);
   g_state.dayPnL = 0.0;
   g_state.tradesToday = 0;
   g_state.blockedToday = 0;
   g_state.halted = false;
   g_state.haltReason = "";
}

void EnsureStateInitialized()
{
   if(g_state.dayStart == 0)
      ResetStateForNewDay();

   const datetime today = TodayKey();
   if(g_state.dayStart != today)
      ResetStateForNewDay();

   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_state.peakEquity = MathMax(g_state.peakEquity, equity);
   g_state.dayPnL = equity - g_state.dayStartEquity;

   if(g_state.dayPnL <= -(g_state.dayStartEquity * (MaxDailyLossPct / 100.0)))
   {
      g_state.halted = true;
      g_state.haltReason = "daily_loss_limit";
   }

   if(equity <= g_state.peakEquity * (1.0 - (MaxDrawdownPct / 100.0)))
   {
      g_state.halted = true;
      g_state.haltReason = "drawdown_limit";
   }
}

bool LoadState()
{
   if(!FileExistsCommon(StateFileName))
   {
      ResetStateForNewDay();
      return true;
   }

   const string raw = ReadCommonText(StateFileName);
   if(raw == "")
   {
      ResetStateForNewDay();
      return true;
   }

   g_state.dayStart = (datetime)JsonNumber(raw, "dayStart", (double)TodayKey());
   g_state.lastSignalAt = (datetime)JsonNumber(raw, "lastSignalAt", 0.0);
   g_state.lastSignalHash = JsonString(raw, "lastSignalHash", "");
   g_state.lastSignalId = JsonString(raw, "lastSignalId", "");
   g_state.dayStartEquity = JsonNumber(raw, "dayStartEquity", AccountInfoDouble(ACCOUNT_EQUITY));
   g_state.peakEquity = JsonNumber(raw, "peakEquity", AccountInfoDouble(ACCOUNT_EQUITY));
   g_state.dayPnL = JsonNumber(raw, "dayPnL", 0.0);
   g_state.tradesToday = (int)JsonNumber(raw, "tradesToday", 0);
   g_state.blockedToday = (int)JsonNumber(raw, "blockedToday", 0);
   g_state.halted = JsonBool(raw, "halted", false);
   g_state.haltReason = JsonString(raw, "haltReason", "");

   EnsureStateInitialized();
   return true;
}

bool SaveState()
{
   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_state.peakEquity = MathMax(g_state.peakEquity, equity);
   g_state.dayPnL = equity - g_state.dayStartEquity;

   string json = "{\n";
   json += "\"dayStart\":" + LongToJson((long)g_state.dayStart) + ",\n";
   json += "\"lastSignalAt\":" + LongToJson((long)g_state.lastSignalAt) + ",\n";
   json += "\"lastSignalHash\":\"" + g_state.lastSignalHash + "\",\n";
   json += "\"lastSignalId\":\"" + g_state.lastSignalId + "\",\n";
   json += "\"dayStartEquity\":" + DoubleToJson(g_state.dayStartEquity, 2) + ",\n";
   json += "\"peakEquity\":" + DoubleToJson(g_state.peakEquity, 2) + ",\n";
   json += "\"dayPnL\":" + DoubleToJson(g_state.dayPnL, 2) + ",\n";
   json += "\"tradesToday\":" + IntegerToString(g_state.tradesToday) + ",\n";
   json += "\"blockedToday\":" + IntegerToString(g_state.blockedToday) + ",\n";
   json += "\"halted\":" + BoolToJson(g_state.halted) + ",\n";
   json += "\"haltReason\":\"" + g_state.haltReason + "\"\n";
   json += "}";

   return WriteCommonText(StateFileName, json);
}

void LogJournal(const string eventType, const string message, const string payload = "")
{
   string line = "{";
   line += "\"ts\":" + LongToJson((long)TimeCurrent()) + ",";
   line += "\"type\":\"" + eventType + "\",";
   line += "\"message\":\"" + message + "\"";
   if(payload != "")
      line += ",\"payload\":\"" + payload + "\"";
   line += "}";
   AppendCommonText(JournalFileName, line);
}

//============================================================
// Utility math / market functions
//============================================================

double SymbolPointValue(const string symbol)
{
   double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
   if(point <= 0.0)
      point = _Point;
   return point;
}

int SymbolDigitsSafe(const string symbol)
{
   int digits = (int)SymbolInfoInteger(symbol, SYMBOL_DIGITS);
   if(digits <= 0)
      digits = _Digits;
   return digits;
}

int LotDigitsFromStep(double step)
{
   if(step <= 0.0)
      return 2;

   int digits = 0;
   while(step < 1.0 && digits < 8)
   {
      step *= 10.0;
      digits++;
   }
   return digits;
}

double NormalizeVolumeStep(const string symbol, double volume)
{
   const double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   const double maxLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   if(step <= 0.0)
      step = 0.01;

   volume = MathMax(minLot, MathMin(maxLot, volume));
   volume = MathFloor(volume / step) * step;
    volume = NormalizeDouble(volume, LotDigitsFromStep(step));

   if(volume < minLot)
      volume = minLot;
   return volume;
}

double ClampDouble(const double value, const double minValue, const double maxValue)
{
   return MathMax(minValue, MathMin(maxValue, value));
}

bool IsWithinSession()
{
   if(!RespectTradeSession)
      return true;

   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   if(SessionStartHour <= SessionEndHour)
      return dt.hour >= SessionStartHour && dt.hour <= SessionEndHour;

   // overnight session
   return dt.hour >= SessionStartHour || dt.hour <= SessionEndHour;
}

bool IsMarketOpenBySymbol(const string symbol)
{
   long tradeMode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
   if(tradeMode == SYMBOL_TRADE_MODE_DISABLED)
      return false;

   return true;
}

double AverageVolume(const MqlRates &rates[], const int fromIndex, const int toIndex)
{
   if(toIndex <= fromIndex)
      return 0.0;

   double sum = 0.0;
   int count = 0;
   for(int i = fromIndex; i < toIndex; i++)
   {
      sum += (double)rates[i].tick_volume;
      count++;
   }

   return count > 0 ? sum / count : 0.0;
}

double CalcEMAOnRates(const MqlRates &rates[], const int period, const int startIndex, const int endIndex)
{
   if(endIndex < startIndex || period <= 1)
      return 0.0;

   const double k = 2.0 / (period + 1.0);
   double ema = rates[startIndex].close;

   for(int i = startIndex + 1; i <= endIndex; i++)
      ema = rates[i].close * k + ema * (1.0 - k);

   return ema;
}

double CalcATROnRates(const MqlRates &rates[], const int period, const int endIndex)
{
   if(endIndex < 1)
      return 0.0;

   const int startIndex = MathMax(1, endIndex - period + 1);
   double sum = 0.0;
   int count = 0;

   for(int i = startIndex; i <= endIndex; i++)
   {
      const double range1 = rates[i].high - rates[i].low;
      const double range2 = MathAbs(rates[i].high - rates[i - 1].close);
      const double range3 = MathAbs(rates[i].low - rates[i - 1].close);
      sum += MathMax(range1, MathMax(range2, range3));
      count++;
   }

   return count > 0 ? sum / count : 0.0;
}

double CalcRSIOnRates(const MqlRates &rates[], const int period, const int endIndex)
{
   if(endIndex < period)
      return 50.0;

   double gains = 0.0;
   double losses = 0.0;
   const int startIndex = endIndex - period + 1;

   for(int i = startIndex; i <= endIndex; i++)
   {
      const double change = rates[i].close - rates[i - 1].close;
      if(change >= 0)
         gains += change;
      else
         losses -= change;
   }

   if(gains == 0.0 && losses == 0.0)
      return 50.0;
   if(losses == 0.0)
      return 100.0;

   const double rs = (gains / period) / (losses / period);
   return 100.0 - (100.0 / (1.0 + rs));
}

double CalcDirectionalStrength(const MqlRates &rates[], const int period, const int endIndex)
{
   if(endIndex < period + 1)
      return 0.0;

   double plusDM = 0.0;
   double minusDM = 0.0;
   double trSum = 0.0;
   const int startIndex = endIndex - period + 1;

   for(int i = startIndex; i <= endIndex; i++)
   {
      const double upMove = rates[i].high - rates[i - 1].high;
      const double downMove = rates[i - 1].low - rates[i].low;
      const double tr1 = rates[i].high - rates[i].low;
      const double tr2 = MathAbs(rates[i].high - rates[i - 1].close);
      const double tr3 = MathAbs(rates[i].low - rates[i - 1].close);
      const double trueRange = MathMax(tr1, MathMax(tr2, tr3));

      if(upMove > downMove && upMove > 0.0)
         plusDM += upMove;
      if(downMove > upMove && downMove > 0.0)
         minusDM += downMove;

      trSum += trueRange;
   }

   if(trSum <= 0.0)
      return 0.0;

   const double plusDI = 100.0 * (plusDM / trSum);
   const double minusDI = 100.0 * (minusDM / trSum);
   const double denom = plusDI + minusDI;
   if(denom <= 0.0)
      return 0.0;

   return 100.0 * MathAbs(plusDI - minusDI) / denom;
}

double LowestLow(const MqlRates &rates[], const int startIndex, const int endIndex)
{
   double low = rates[startIndex].low;
   for(int i = startIndex + 1; i <= endIndex; i++)
      low = MathMin(low, rates[i].low);
   return low;
}

double HighestHigh(const MqlRates &rates[], const int startIndex, const int endIndex)
{
   double high = rates[startIndex].high;
   for(int i = startIndex + 1; i <= endIndex; i++)
      high = MathMax(high, rates[i].high);
   return high;
}

bool DetectBullishBreak(const MqlRates &rates[], const int endIndex, const int lookback, double &level)
{
   if(endIndex <= lookback)
      return false;

   const int startIndex = endIndex - lookback;
   level = HighestHigh(rates, startIndex, endIndex - 1);
   return rates[endIndex].close > level && rates[endIndex - 1].close <= level;
}

bool DetectBearishBreak(const MqlRates &rates[], const int endIndex, const int lookback, double &level)
{
   if(endIndex <= lookback)
      return false;

   const int startIndex = endIndex - lookback;
   level = LowestLow(rates, startIndex, endIndex - 1);
   return rates[endIndex].close < level && rates[endIndex - 1].close >= level;
}

bool DetectSweepHigh(const MqlRates &rates[], const int endIndex, const int lookback, double &level)
{
   if(endIndex <= lookback)
      return false;

   const int startIndex = endIndex - lookback;
   level = HighestHigh(rates, startIndex, endIndex - 1);
   return rates[endIndex].high > level && rates[endIndex].close < level;
}

bool DetectSweepLow(const MqlRates &rates[], const int endIndex, const int lookback, double &level)
{
   if(endIndex <= lookback)
      return false;

   const int startIndex = endIndex - lookback;
   level = LowestLow(rates, startIndex, endIndex - 1);
   return rates[endIndex].low < level && rates[endIndex].close > level;
}

bool DetectFVGUp(const MqlRates &rates[], const int endIndex, double &gapLow, double &gapHigh)
{
   if(endIndex < 2)
      return false;

   if(rates[endIndex].low > rates[endIndex - 2].high)
   {
      gapLow = rates[endIndex - 2].high;
      gapHigh = rates[endIndex].low;
      return true;
   }
   return false;
}

bool DetectFVGDown(const MqlRates &rates[], const int endIndex, double &gapLow, double &gapHigh)
{
   if(endIndex < 2)
      return false;

   if(rates[endIndex].high < rates[endIndex - 2].low)
   {
      gapLow = rates[endIndex].high;
      gapHigh = rates[endIndex - 2].low;
      return true;
   }
   return false;
}

double SpreadPoints(const string symbol)
{
   const double bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   const double ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   const double point = SymbolPointValue(symbol);
   if(point <= 0.0)
      return 0.0;
   return (ask - bid) / point;
}

//============================================================
// Market analysis and export
//============================================================

MarketStats AnalyzeMarket(const string symbol, const ENUM_TIMEFRAMES timeframe, const MqlRates &rates[], const int count)
{
   MarketStats s;
   s.symbol = symbol;
   s.timeframe = timeframe;
   s.generatedAt = TimeCurrent();
   s.bid = SymbolInfoDouble(symbol, SYMBOL_BID);
   s.ask = SymbolInfoDouble(symbol, SYMBOL_ASK);
   s.spreadPoints = SpreadPoints(symbol);

   if(count < 20)
   {
      s.bias = "neutral";
      return s;
   }

   const int last = count - 1;
   const int emaSlowPeriod = MathMin(200, MathMax(50, count / 2));
   const int atrPeriod = MathMin(14, count - 1);
   const int rsiPeriod = MathMin(14, count - 1);
   const int adxPeriod = MathMin(14, count - 1);
   const int volLookback = MathMin(20, count - 1);

   s.emaFast = CalcEMAOnRates(rates, MathMin(20, count - 1), 0, last);
   s.emaSlow = CalcEMAOnRates(rates, emaSlowPeriod, 0, last);
   s.atr = CalcATROnRates(rates, atrPeriod, last);
   s.rsi = CalcRSIOnRates(rates, rsiPeriod, last);
   s.adx = CalcDirectionalStrength(rates, adxPeriod, last);
   s.support = LowestLow(rates, MathMax(0, last - 40), last);
   s.resistance = HighestHigh(rates, MathMax(0, last - 40), last);

   const double avgVol = AverageVolume(rates, MathMax(0, last - volLookback), last);
   s.volumeRatio = avgVol > 0.0 ? (double)rates[last].tick_volume / avgVol : 1.0;

   const double close = rates[last].close;
   const double trendDiff = s.emaFast - s.emaSlow;
   const double trendStrength = s.atr > 0.0 ? MathAbs(trendDiff) / s.atr : 0.0;
   s.trendScore = ClampDouble(trendStrength / 2.0, 0.0, 1.0);
   s.volatilityScore = ClampDouble(s.atr / MathMax(close * 0.01, 1e-6), 0.0, 2.0) / 2.0;

   double bullBreakLevel = 0.0;
   double bearBreakLevel = 0.0;
   double sweepLevel = 0.0;
   double gapLow = 0.0;
   double gapHigh = 0.0;
   s.bosUp = DetectBullishBreak(rates, last, 12, bullBreakLevel);
   s.bosDown = DetectBearishBreak(rates, last, 12, bearBreakLevel);
   s.sweepHigh = DetectSweepHigh(rates, last, 12, sweepLevel);
   s.sweepLow = DetectSweepLow(rates, last, 12, sweepLevel);
   s.fvgUp = DetectFVGUp(rates, last, gapLow, gapHigh);
   s.fvgDown = DetectFVGDown(rates, last, gapLow, gapHigh);

   const bool bullishMomentum = s.emaFast >= s.emaSlow && s.rsi >= 50.0;
   const bool bearishMomentum = s.emaFast < s.emaSlow && s.rsi < 50.0;

   if(bullishMomentum)
      s.bias = "bullish";
   else if(bearishMomentum)
      s.bias = "bearish";
   else
      s.bias = "neutral";

   // CHOCH approximation: trend shift against the EMA regime
   s.chochUp = s.bias == "bullish" && s.bosUp && s.rsi > 55.0;
   s.chochDown = s.bias == "bearish" && s.bosDown && s.rsi < 45.0;

   if(s.spreadPoints > MaxSpreadPoints)
      s.bias = "neutral";

   return s;
}

string MarketStatsToJson(const MarketStats &s)
{
   string json = "{";
   json += "\"symbol\":\"" + s.symbol + "\",";
   json += "\"timeframe\":\"" + EnumToString(s.timeframe) + "\",";
   json += "\"generatedAt\":" + LongToJson((long)s.generatedAt) + ",";
   json += "\"bid\":" + DoubleToJson(s.bid, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"ask\":" + DoubleToJson(s.ask, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"spreadPoints\":" + DoubleToJson(s.spreadPoints, 1) + ",";
   json += "\"emaFast\":" + DoubleToJson(s.emaFast, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"emaSlow\":" + DoubleToJson(s.emaSlow, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"atr\":" + DoubleToJson(s.atr, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"rsi\":" + DoubleToJson(s.rsi, 2) + ",";
   json += "\"adx\":" + DoubleToJson(s.adx, 2) + ",";
   json += "\"volumeRatio\":" + DoubleToJson(s.volumeRatio, 3) + ",";
   json += "\"support\":" + DoubleToJson(s.support, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"resistance\":" + DoubleToJson(s.resistance, SymbolDigitsSafe(s.symbol)) + ",";
   json += "\"trendScore\":" + DoubleToJson(s.trendScore, 3) + ",";
   json += "\"volatilityScore\":" + DoubleToJson(s.volatilityScore, 3) + ",";
   json += "\"bias\":\"" + s.bias + "\",";
   json += "\"bosUp\":" + BoolToJson(s.bosUp) + ",";
   json += "\"bosDown\":" + BoolToJson(s.bosDown) + ",";
   json += "\"chochUp\":" + BoolToJson(s.chochUp) + ",";
   json += "\"chochDown\":" + BoolToJson(s.chochDown) + ",";
   json += "\"sweepHigh\":" + BoolToJson(s.sweepHigh) + ",";
   json += "\"sweepLow\":" + BoolToJson(s.sweepLow) + ",";
   json += "\"fvgUp\":" + BoolToJson(s.fvgUp) + ",";
   json += "\"fvgDown\":" + BoolToJson(s.fvgDown);
   json += "}";
   return json;
}

bool ExportMarketSnapshot()
{
   if(!ExportMarketData)
      return true;

   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   const int copied = CopyRates(_Symbol, _Period, 0, MarketBars, rates);
   if(copied <= 0)
   {
      Print("No se pudieron copiar velas. error=", GetLastError());
      return false;
   }

   MarketStats stats = AnalyzeMarket(_Symbol, (ENUM_TIMEFRAMES)_Period, rates, copied);
   const int digits = SymbolDigitsSafe(_Symbol);

   string json = "{\n";
   json += "\"symbol\":\"" + _Symbol + "\",\n";
   json += "\"timeframe\":\"" + EnumToString((ENUM_TIMEFRAMES)_Period) + "\",\n";
   json += "\"generatedAt\":" + LongToJson((long)TimeCurrent()) + ",\n";
   json += "\"bars\":[\n";

   for(int i = 0; i < copied; i++)
   {
      json += "{";
      json += "\"time\":" + LongToJson((long)rates[i].time) + ",";
      json += "\"timestamp\":" + LongToJson((long)rates[i].time * 1000L) + ",";
      json += "\"open\":" + DoubleToJson(rates[i].open, digits) + ",";
      json += "\"high\":" + DoubleToJson(rates[i].high, digits) + ",";
      json += "\"low\":" + DoubleToJson(rates[i].low, digits) + ",";
      json += "\"close\":" + DoubleToJson(rates[i].close, digits) + ",";
      json += "\"volume\":" + LongToJson((long)rates[i].tick_volume) + "}";
      if(i < copied - 1)
         json += ",\n";
   }

   json += "\n],\n";
   json += "\"analysis\":" + MarketStatsToJson(stats) + "\n";
   json += "}";

   if(!WriteCommonText(MarketFileName, json))
      return false;

   g_lastMarketHash = HashText(json);
   return true;
}

//============================================================
// News filter
//============================================================

bool NewsFilterBlocksTrading()
{
   if(!UseNewsFilter)
      return false;

   if(!FileExistsCommon(NewsFileName))
      return false;

   const string raw = ReadCommonText(NewsFileName);
   if(raw == "")
      return false;

   if(JsonBool(raw, "blocked", false))
      return true;

   const datetime now = TimeCurrent();
   const datetime blackoutUntil = JsonDatetimeMs(raw, "blackoutUntil", 0);
   if(blackoutUntil > 0 && now < blackoutUntil)
      return true;

   const datetime eventAt = JsonDatetimeMs(raw, "eventAt", 0);
   if(eventAt > 0)
   {
      const int before = (int)JsonNumber(raw, "beforeMinutes", NewsBeforeMinutes);
      const int after = (int)JsonNumber(raw, "afterMinutes", NewsAfterMinutes);
      const datetime windowStart = eventAt - before * 60;
      const datetime windowEnd = eventAt + after * 60;
      if(now >= windowStart && now <= windowEnd)
         return true;
   }

   const string category = ToLowerValue(JsonString(raw, "category", ""));
   if(category == "high" || category == "red")
   {
      const string symbol = ToLowerValue(JsonString(raw, "symbol", ""));
      if(symbol == "" || StringFind(ToLowerValue(_Symbol), symbol) >= 0)
         return true;
   }

   return false;
}

//============================================================
// Position runtime and management
//============================================================

string TicketKeyPrefix(const string kind, const ulong ticket)
{
   return "TradingBotAI_" + kind + "_" + LongToJson((long)ticket);
}

bool IsPartialDone(const ulong ticket)
{
   return GlobalVariableCheck(TicketKeyPrefix("partial", ticket));
}

void MarkPartialDone(const ulong ticket)
{
   GlobalVariableSet(TicketKeyPrefix("partial", ticket), 1.0);
}

bool IsBreakEvenDone(const ulong ticket)
{
   return GlobalVariableCheck(TicketKeyPrefix("be", ticket));
}

void MarkBreakEvenDone(const ulong ticket)
{
   GlobalVariableSet(TicketKeyPrefix("be", ticket), 1.0);
}

void RemoveRuntimeFlags(const ulong ticket)
{
   const string partial = TicketKeyPrefix("partial", ticket);
   const string be = TicketKeyPrefix("be", ticket);
   if(GlobalVariableCheck(partial))
      GlobalVariableDel(partial);
   if(GlobalVariableCheck(be))
      GlobalVariableDel(be);
}

int CountPositionsForSymbol(const string symbol)
{
   int total = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      const ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != symbol)
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;
      total++;
   }
   return total;
}

int CountPositionsForSide(const string symbol, const long sideType)
{
   int total = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      const ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != symbol)
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;
      if(PositionGetInteger(POSITION_TYPE) == sideType)
         total++;
   }
   return total;
}

bool ClosePositionsForSide(const string symbol, const long sideType)
{
   bool ok = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      const ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != symbol)
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;
      if(PositionGetInteger(POSITION_TYPE) != sideType)
         continue;

      if(!trade.PositionClose(ticket))
      {
         ok = false;
         Print("No se pudo cerrar ticket ", ticket, " error=", GetLastError());
      }
      else
      {
         RemoveRuntimeFlags(ticket);
      }
   }
   return ok;
}

PositionRuntime BuildPositionRuntime(const ulong ticket)
{
   PositionRuntime p;
   p.ticket = ticket;
   p.symbol = "";
   p.type = -1;
   p.volume = 0.0;
   p.openPrice = 0.0;
   p.currentPrice = 0.0;
   p.profitPoints = 0.0;
   p.floatingPnl = 0.0;
   p.beDone = false;
   p.partialDone = false;

   if(ticket == 0 || !PositionSelectByTicket(ticket))
      return p;

   p.symbol = PositionGetString(POSITION_SYMBOL);
   p.type = (long)PositionGetInteger(POSITION_TYPE);
   p.volume = PositionGetDouble(POSITION_VOLUME);
   p.openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
   p.currentPrice = (p.type == POSITION_TYPE_BUY)
                  ? SymbolInfoDouble(p.symbol, SYMBOL_BID)
                  : SymbolInfoDouble(p.symbol, SYMBOL_ASK);
   p.floatingPnl = PositionGetDouble(POSITION_PROFIT);

   const double point = SymbolPointValue(p.symbol);
   if(point > 0.0)
   {
      if(p.type == POSITION_TYPE_BUY)
         p.profitPoints = (p.currentPrice - p.openPrice) / point;
      else
         p.profitPoints = (p.openPrice - p.currentPrice) / point;
   }

   p.beDone = IsBreakEvenDone(ticket);
   p.partialDone = IsPartialDone(ticket);
   return p;
}

bool ModifyPositionSLTP(const string symbol, const double sl, const double tp)
{
   return trade.PositionModify(symbol, sl, tp);
}

bool ApplyBreakEven(const PositionRuntime &p)
{
   if(!UseBreakEven || p.profitPoints < BreakEvenTriggerPoints)
      return false;
   if(p.beDone)
      return false;

   const int digits = SymbolDigitsSafe(p.symbol);
   const double point = SymbolPointValue(p.symbol);
   const double plus = BreakEvenPlusPoints * point;
   const double newSL = (p.type == POSITION_TYPE_BUY)
                      ? NormalizeDouble(p.openPrice + plus, digits)
                      : NormalizeDouble(p.openPrice - plus, digits);

   const double currentSL = PositionGetDouble(POSITION_SL);
   const double currentTP = PositionGetDouble(POSITION_TP);
   bool better = false;
   if(p.type == POSITION_TYPE_BUY)
      better = currentSL <= 0.0 || newSL > currentSL;
   else
      better = currentSL <= 0.0 || newSL < currentSL;

   if(!better)
      return false;

   if(trade.PositionModify(p.symbol, newSL, currentTP))
   {
      MarkBreakEvenDone(p.ticket);
      return true;
   }
   return false;
}

bool ApplyTrailingStop(const PositionRuntime &p)
{
   if(!UseTrailingStop || p.profitPoints < TrailingStartPoints)
      return false;

   const int digits = SymbolDigitsSafe(p.symbol);
   const double point = SymbolPointValue(p.symbol);
   const double trailDistance = TrailingDistancePoints * point;
   const double step = MathMax(TrailingStepPoints, 1) * point;
   const double currentSL = PositionGetDouble(POSITION_SL);
   const double currentTP = PositionGetDouble(POSITION_TP);
   double desiredSL = currentSL;

   if(p.type == POSITION_TYPE_BUY)
   {
      desiredSL = NormalizeDouble(p.currentPrice - trailDistance, digits);
      if(currentSL > 0.0 && desiredSL <= currentSL + step)
         return false;
      if(desiredSL >= p.currentPrice)
         return false;
   }
   else
   {
      desiredSL = NormalizeDouble(p.currentPrice + trailDistance, digits);
      if(currentSL > 0.0 && desiredSL >= currentSL - step)
         return false;
      if(desiredSL <= p.currentPrice)
         return false;
   }

   if(trade.PositionModify(p.symbol, desiredSL, currentTP))
      return true;

   return false;
}

bool ApplyPartialClose(const PositionRuntime &p)
{
   if(!UsePartialClose || p.partialDone || p.profitPoints < PartialCloseTriggerPoints)
      return false;

   double closeVolume = p.volume * (PartialClosePercent / 100.0);
   closeVolume = NormalizeVolumeStep(p.symbol, closeVolume);

   const double minLot = SymbolInfoDouble(p.symbol, SYMBOL_VOLUME_MIN);
   if(closeVolume < minLot || closeVolume >= p.volume)
      return false;

   if(trade.PositionClosePartial(p.ticket, closeVolume))
   {
      MarkPartialDone(p.ticket);
      return true;
   }
   return false;
}

void ManageOpenPositions()
{
   if(!ManageOpenPositionsEnabled)
      return;

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      const ulong ticket = PositionGetTicket(i);
      if(ticket == 0)
         continue;
      if(!PositionSelectByTicket(ticket))
         continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol)
         continue;
      if((ulong)PositionGetInteger(POSITION_MAGIC) != MagicNumber)
         continue;

      const PositionRuntime p = BuildPositionRuntime(ticket);
      ApplyBreakEven(p);
      ApplyTrailingStop(p);
      ApplyPartialClose(p);
   }
}

//============================================================
// Signal processing
//============================================================

SignalSnapshot ParseSignal(const string raw)
{
   SignalSnapshot s;
   s.raw = raw;
   s.hash = HashText(raw);
   s.signalId = JsonString(raw, "signalId", "");
   s.symbol = JsonString(raw, "symbol", "");
   s.side = ToLowerValue(JsonString(raw, "side", ""));
   s.entry = JsonNumber(raw, "entry", 0.0);
   s.stopLoss = JsonNumber(raw, "stopLoss", 0.0);
   s.takeProfit = JsonNumber(raw, "takeProfit", 0.0);
   s.confidence = JsonNumber(raw, "confidence", 0.0);
   s.confluenceScore = JsonNumber(raw, "confluenceScore", 0.0);
   s.regime = ToLowerValue(JsonString(raw, "regime", ""));
   s.generatedAt = ParseFlexibleDateTime(JsonString(raw, "generatedAt", JsonString(raw, "generated_at", "")));
   s.ageMinutes = 0;
   s.valid = false;
   s.reason = "";

   if(s.generatedAt > 0)
      s.ageMinutes = (int)((TimeCurrent() - s.generatedAt) / 60);

   return s;
}

bool ValidateSignal(const SignalSnapshot &s, string &whyNot)
{
   if(s.raw == "")
   {
      whyNot = "empty_payload";
      return false;
   }

   if(s.side != "buy" && s.side != "sell")
   {
      whyNot = "invalid_side";
      return false;
   }

   if(s.confidence < MinConfidence)
   {
      whyNot = "low_confidence";
      return false;
   }

   if(s.confluenceScore < MinConfluence)
   {
      whyNot = "low_confluence";
      return false;
   }

   if(s.entry <= 0.0 || s.stopLoss <= 0.0 || s.takeProfit <= 0.0)
   {
      whyNot = "invalid_levels";
      return false;
   }

   if(s.generatedAt > 0 && s.ageMinutes > MaxSignalAgeMinutes)
   {
      whyNot = "signal_too_old";
      return false;
   }

   if(UseNewsFilter && NewsFilterBlocksTrading())
   {
      whyNot = "news_blackout";
      return false;
   }

   if(!IsWithinSession())
   {
      whyNot = "outside_session";
      return false;
   }

   if(!IsMarketOpenBySymbol(_Symbol))
   {
      whyNot = "symbol_closed";
      return false;
   }

   if(SpreadPoints(_Symbol) > MaxSpreadPoints)
   {
      whyNot = "spread_too_wide";
      return false;
   }

   if(g_state.halted)
   {
      whyNot = g_state.haltReason != "" ? g_state.haltReason : "bot_halted";
      return false;
   }

   whyNot = "";
   return true;
}

double CalculateRiskLots(const string symbol, const double entry, const double sl, const double confidence, const double confluence)
{
   if(!UseRiskSizing)
      return NormalizeVolumeStep(symbol, FixedLots);

   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   const double riskFactor = ClampDouble(0.75 + confidence * 0.4 + confluence * 0.3, 0.5, 1.25);
   const double riskMoney = equity * (RiskPercent / 100.0) * riskFactor;
   const double point = SymbolPointValue(symbol);
   const double stopPoints = MathAbs(entry - sl) / point;
   if(stopPoints <= 0.0)
      return 0.0;

   const double tickSize = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   const double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   const double valuePerPoint = (tickSize > 0.0) ? (tickValue / tickSize) * point : tickValue;
   if(valuePerPoint <= 0.0)
      return 0.0;

   double lots = riskMoney / (stopPoints * valuePerPoint);
   lots = NormalizeVolumeStep(symbol, lots);
   return lots;
}

bool CloseOppositePositionsIfNeeded(const string symbol, const string side)
{
   if(!CloseOpposite)
      return true;

   const long oppositeType = (side == "buy") ? POSITION_TYPE_SELL : POSITION_TYPE_BUY;
   return ClosePositionsForSide(symbol, oppositeType);
}

bool ExecuteSignalTrade(const SignalSnapshot &s)
{
   if(OnePositionPerSymbol && CountPositionsForSymbol(_Symbol) >= MaxPositionsPerSymbol)
   {
      g_state.blockedToday++;
      LogJournal("blocked", "max_positions", s.raw);
      return false;
   }

   if(!CloseOppositePositionsIfNeeded(_Symbol, s.side))
   {
      g_state.blockedToday++;
      LogJournal("blocked", "failed_close_opposite", s.raw);
      return false;
   }

   const double lots = CalculateRiskLots(_Symbol, s.entry, s.stopLoss, s.confidence, s.confluenceScore);
   if(lots <= 0.0)
   {
      g_state.blockedToday++;
      LogJournal("blocked", "invalid_lot_size", s.raw);
      return false;
   }

   trade.SetExpertMagicNumber((long)MagicNumber);
   trade.SetDeviationInPoints(DeviationPoints);
   trade.SetTypeFillingBySymbol(_Symbol);

   const int digits = SymbolDigitsSafe(_Symbol);
   const double sl = NormalizeDouble(s.stopLoss, digits);
   const double tp = NormalizeDouble(s.takeProfit, digits);
   bool ok = false;

   if(s.side == "buy")
      ok = trade.Buy(lots, _Symbol, 0.0, sl, tp, "TradingBotAI");
   else
      ok = trade.Sell(lots, _Symbol, 0.0, sl, tp, "TradingBotAI");

   if(ok)
   {
      g_state.tradesToday++;
      g_state.lastSignalAt = TimeCurrent();
      g_state.lastSignalHash = s.hash;
      g_state.lastSignalId = (s.signalId != "" ? s.signalId : s.hash);
      g_state.halted = false;
      g_state.haltReason = "";
      LogJournal("trade", "signal_executed", s.raw);
      return true;
   }

   const int err = GetLastError();
   LogJournal("error", "order_failed_" + IntegerToString(err), s.raw);
   return false;
}

bool ProcessSignal()
{
   if(!FileExistsCommon(SignalFileName))
      return false;

   const string raw = ReadCommonText(SignalFileName);
   if(raw == "")
      return false;

   const string hash = HashText(raw);
   if(hash == g_state.lastSignalHash)
      return false;

   SignalSnapshot s = ParseSignal(raw);
   string reason = "";
   if(!ValidateSignal(s, reason))
   {
      g_state.blockedToday++;
      g_state.lastSignalHash = hash;
      LogJournal("blocked", reason, raw);
      return false;
   }

   if(s.symbol != "" && ToLowerValue(s.symbol) != ToLowerValue(_Symbol))
   {
      Print("Señal para ", s.symbol, " ignorada en ", _Symbol);
      g_state.lastSignalHash = hash;
      LogJournal("skip", "symbol_mismatch", raw);
      return false;
   }

   if(CountPositionsForSide(_Symbol, (s.side == "buy") ? POSITION_TYPE_BUY : POSITION_TYPE_SELL) > 0 && OnePositionPerSymbol)
   {
      g_state.lastSignalHash = hash;
      LogJournal("skip", "same_side_position_exists", raw);
      return false;
   }

   const bool executed = ExecuteSignalTrade(s);
   g_state.lastSignalHash = hash;
   return executed;
}

//============================================================
// Trade transaction hook
//============================================================

void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      LogJournal("deal", "deal_added", IntegerToString((int)trans.deal));
   }

   if(trans.type == TRADE_TRANSACTION_ORDER_ADD)
   {
      LogJournal("order", "order_added", IntegerToString((int)trans.order));
   }

   if(trans.type == TRADE_TRANSACTION_ORDER_DELETE)
   {
      LogJournal("order", "order_deleted", IntegerToString((int)trans.order));
   }
}

//============================================================
// Main cycle
//============================================================

void RefreshBotHealth()
{
   EnsureStateInitialized();
   const double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   g_state.peakEquity = MathMax(g_state.peakEquity, equity);
   g_state.dayPnL = equity - g_state.dayStartEquity;

   if(g_state.dayPnL <= -(g_state.dayStartEquity * (MaxDailyLossPct / 100.0)))
   {
      g_state.halted = true;
      g_state.haltReason = "daily_loss_limit";
   }

   if(equity <= g_state.peakEquity * (1.0 - (MaxDrawdownPct / 100.0)))
   {
      g_state.halted = true;
      g_state.haltReason = "drawdown_limit";
   }
}

void ReportStatus()
{
   Print("TradingBotBridgeEA | equity=", DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2),
         " pnl=", DoubleToString(g_state.dayPnL, 2),
         " tradesToday=", g_state.tradesToday,
         " blockedToday=", g_state.blockedToday,
         " halted=", (g_state.halted ? "true" : "false"),
         " reason=", g_state.haltReason);
}

int OnInit()
{
   LoadState();
   EventSetTimer(TimerSeconds);
   RefreshBotHealth();
   ExportMarketSnapshot();

   Print("TradingBotBridgeEA iniciado.");
   Print("SignalFile: ", SignalFileName);
   Print("MarketFile: ", MarketFileName);
   Print("StateFile: ", StateFileName);
   Print("JournalFile: ", JournalFileName);
   Print("MagicNumber: ", (long)MagicNumber);
   Print("Symbol: ", _Symbol, " Period: ", EnumToString((ENUM_TIMEFRAMES)_Period));
   ReportStatus();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   SaveState();
   Print("TradingBotBridgeEA detenido. reason=", reason);
}

void OnTick()
{
   // Intentionally empty. The timer drives the bridge to keep behavior deterministic.
}

void OnTimer()
{
   RefreshBotHealth();

   if(ExportMarketData)
      ExportMarketSnapshot();

   ManageOpenPositions();
   ProcessSignal();
   SaveState();
   ReportStatus();
}
