'use strict';

/**
 * agents.js — Dual AI Agent System ("Two Voices")
 *
 * Agent 1: "Bull" — Looks for reasons TO take the trade
 * Agent 2: "Bear" — Looks for reasons NOT to take the trade
 *
 * Both agents review every proposed trade. The trade only fires if:
 *   - Bull says YES (confidence >= 0.6)
 *   - Bear does NOT veto (confidence < 0.7)
 *
 * This creates a natural tension that filters out marginal trades
 * while letting strong setups through.
 */

const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./logger');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';

let _client = null;
function getClient() {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

let _totalTokens = 0;
function getTokensUsed() { return _totalTokens; }

// ─── Agent prompts ───────────────────────────────────────────────────────────

const BULL_SYSTEM = `You are the BULL ANALYST for a live trading bot on a $100 CFD account.
Your job: find reasons WHY this trade should be taken.
Look for: strong trend alignment, momentum confirmation, clean technical setup, favorable risk/reward.
Be decisive — you want to find winners, but you also want to protect the account.

Return ONLY JSON:
{
  "vote": "YES" or "NO",
  "confidence": 0.0 to 1.0,
  "reason": "one sentence why"
}`;

const BEAR_SYSTEM = `You are the BEAR ANALYST (risk manager) for a live trading bot on a $100 CFD account.
Your job: find reasons WHY this trade should NOT be taken.
Look for: weak signals, conflicting indicators, bad timing, overexposure, choppy conditions, low volume.
Be skeptical — your job is to protect capital. Only let truly strong setups through.

Return ONLY JSON:
{
  "vote": "VETO" or "PASS",
  "confidence": 0.0 to 1.0,
  "reason": "one sentence why"
}`;

// ─── Call a single agent ─────────────────────────────────────────────────────
async function callAgent(systemPrompt, tradeContext) {
  const client = getClient();
  if (!client) return null;

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 150,
      messages: [
        { role: 'user', content: `${systemPrompt}\n\nProposed trade:\n${JSON.stringify(tradeContext, null, 2)}` },
      ],
    });

    const text = res.content[0]?.text || '';
    _totalTokens += (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    logger.warn('AGENTS', 'Agent call failed', { error: err.message });
    return null;
  }
}

// ─── Review a proposed trade with both agents ────────────────────────────────
/**
 * @param {Object} trade - Proposed trade details
 * @param {string} trade.symbol
 * @param {string} trade.direction - 'long' or 'short'
 * @param {number} trade.score - Signal score
 * @param {string[]} trade.reasons - Signal reasons
 * @param {number} trade.riskAmount
 * @param {string} trade.regime - 'trending', 'choppy', 'normal'
 * @param {Object} trade.indicators - Key indicator values
 * @param {number} trade.sentiment - Sentiment score
 * @param {string} trade.higherTfBias - Higher timeframe bias
 * @returns {{ approved: boolean, bull: Object, bear: Object }}
 */
async function reviewTrade(trade) {
  const tradeContext = {
    symbol: trade.symbol,
    direction: trade.direction,
    signalScore: trade.score,
    signals: trade.reasons,
    regime: trade.regime,
    riskAmount: trade.riskAmount,
    sentiment: trade.sentiment,
    higherTimeframeBias: trade.higherTfBias,
    rsi: trade.indicators?.rsi7,
    momentum: trade.indicators?.momentum3,
    atr: trade.indicators?.atr7,
    bbBandwidth: trade.indicators?.bb?.bandwidth,
    priceVsVwap: trade.indicators?.close && trade.indicators?.vwap
      ? (trade.indicators.close > trade.indicators.vwap ? 'above' : 'below')
      : 'unknown',
  };

  // Run both agents in parallel for speed
  const [bull, bear] = await Promise.all([
    callAgent(BULL_SYSTEM, tradeContext),
    callAgent(BEAR_SYSTEM, tradeContext),
  ]);

  // Decision logic:
  // - If either agent fails (API down), ALLOW the trade (fail-open so bot keeps trading)
  // - Bull must say YES with >= 0.6 confidence
  // - Bear must NOT veto with >= 0.7 confidence
  let approved = true;
  let reason = '';

  if (bull && bull.vote === 'NO' && (bull.confidence || 0) >= 0.6) {
    approved = false;
    reason = `Bull rejected: ${bull.reason || 'no reason'}`;
  }

  if (bear && bear.vote === 'VETO' && (bear.confidence || 0) >= 0.7) {
    approved = false;
    reason = `Bear vetoed: ${bear.reason || 'no reason'}`;
  }

  if (approved && bull && bull.vote === 'YES') {
    reason = `Bull approved: ${bull.reason || 'looks good'}`;
  }

  const result = {
    approved,
    reason,
    bull: bull || { vote: 'SKIP', confidence: 0, reason: 'Agent unavailable' },
    bear: bear || { vote: 'PASS', confidence: 0, reason: 'Agent unavailable' },
  };

  logger.trade('AGENTS', `${trade.symbol} ${trade.direction} — ${approved ? 'APPROVED' : 'REJECTED'}`, {
    bull: { vote: result.bull.vote, confidence: result.bull.confidence },
    bear: { vote: result.bear.vote, confidence: result.bear.confidence },
    reason,
  });

  return result;
}

// ─── Quick review for high-confidence signals (skip agents if score is very high) ─
/**
 * If signal score is overwhelming (>= 2× minScore), skip the AI review
 * to avoid unnecessary API calls and latency. Strong signals don't need debate.
 */
async function smartReview(trade, minScore) {
  // Auto-approve very strong signals (score >= 2× threshold)
  if (trade.score >= minScore * 2) {
    logger.trade('AGENTS', `${trade.symbol} ${trade.direction} — AUTO-APPROVED (score ${trade.score} >= ${minScore * 2})`, {});
    return { approved: true, reason: 'Auto-approved: overwhelming signal strength', bull: { vote: 'AUTO', confidence: 1 }, bear: { vote: 'PASS', confidence: 0 } };
  }

  return reviewTrade(trade);
}

// ─── Strategy Summit: Bull + Bear collaborate to improve the strategy ─────────
/**
 * Every 4 hours, both agents review recent performance and debate improvements.
 * They each propose changes, then a "mediator" prompt synthesizes their ideas
 * into actionable parameter adjustments.
 *
 * @param {Object} performanceData - Recent trade stats, params, etc.
 * @param {Object} currentParams - Current bot parameters
 * @returns {{ changes: Object[], insight: string } | null}
 */
async function strategySummit(performanceData, currentParams) {
  const client = getClient();
  if (!client) return null;

  const context = JSON.stringify({
    recentPerformance: performanceData,
    currentParams,
  });

  // Step 1: Bull proposes aggressive improvements
  const bullProposal = await callAgent(
    `You are the BULL ANALYST in a strategy review meeting. Analyze recent performance and propose changes to make the bot MORE PROFITABLE.
Focus on: capturing bigger moves, entering earlier on strong signals, increasing position sizes on winners.
Return ONLY JSON:
{
  "proposals": [{"param": "paramName", "value": number, "reason": "why"}],
  "marketView": "one sentence on current market conditions",
  "biggestOpportunity": "one sentence"
}`,
    { context }
  );

  // Step 2: Bear proposes defensive improvements
  const bearProposal = await callAgent(
    `You are the BEAR ANALYST (risk manager) in a strategy review meeting. Analyze recent performance and propose changes to PROTECT CAPITAL and reduce losses.
Focus on: tighter stops on losing setups, avoiding bad market conditions, reducing risk on weak signals.
Return ONLY JSON:
{
  "proposals": [{"param": "paramName", "value": number, "reason": "why"}],
  "marketView": "one sentence on current market conditions",
  "biggestRisk": "one sentence"
}`,
    { context }
  );

  if (!bullProposal && !bearProposal) return null;

  // Step 3: Mediator synthesizes both views into balanced changes
  const mediatorPrompt = `You are the HEAD STRATEGIST mediating between a Bull and Bear analyst.
The Bull wants more profit. The Bear wants less risk. Find the BALANCED middle ground.
Only suggest changes where BOTH analysts somewhat agree, or where one makes an overwhelming case.
This is a LIVE $100 account — capital preservation is priority #1, growth is priority #2.

Allowed parameters and ranges:
- riskPercent: 0.5 to 2 (% of capital per trade)
- atrMultiplier: 2.5 to 3.5 (stop loss distance)
- minScore: 3 to 5 (signal threshold)
- momentumThreshold: 0.002 to 0.006
- cooldownCandles: 5 to 20
- minHoldCandles: 3 to 12
- maxPositions: 2 to 5

Return ONLY JSON:
{
  "changes": [{"param": "paramName", "value": number, "reason": "balanced rationale"}],
  "insight": "one sentence summary of the strategy adjustment",
  "bullAgreement": 0.0 to 1.0,
  "bearAgreement": 0.0 to 1.0
}`;

  const mediatorContext = {
    bullProposal: bullProposal || { proposals: [], marketView: 'unavailable' },
    bearProposal: bearProposal || { proposals: [], marketView: 'unavailable' },
    currentParams,
    recentPerformance: performanceData,
  };

  const result = await callAgent(mediatorPrompt, mediatorContext);
  if (!result) return null;

  logger.optim('AGENTS', 'Strategy Summit complete', {
    bullView: bullProposal?.marketView || 'n/a',
    bearView: bearProposal?.marketView || 'n/a',
    changes: result.changes?.length || 0,
    insight: result.insight || 'no insight',
  });

  // Log the full summit for audit
  const summitRecord = {
    timestamp: new Date().toISOString(),
    bull: bullProposal,
    bear: bearProposal,
    mediator: result,
  };
  const existing = logger.readJSON('agent_summits.json', []);
  existing.push(summitRecord);
  if (existing.length > 50) existing.splice(0, existing.length - 50); // keep last 50
  logger.writeJSON('agent_summits.json', existing);

  return result;
}

module.exports = {
  reviewTrade,
  smartReview,
  strategySummit,
  getTokensUsed,
};
