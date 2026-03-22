#!/usr/bin/env node
'use strict';

/**
 * close_losing_position.js — Emergency utility to close losing positions
 * 
 * Usage:
 *   node scripts/close_losing_position.js BTC    # Close losing BTC position if any
 *   node scripts/close_losing_position.js         # Close most losing position across all
 */

const logger = require('../logger');
const prices = require('../prices');
const executor = require('../executor');

async function closeLosingPosition(targetSymbol = null) {
  const state = logger.readJSON('state.json', {});
  const trades = logger.readJSON('trades.json', []);

  // Initialize
  prices.init({}, { paperTrading: !state.LIVE_TRADING });
  const broker = prices.getBroker();
  if (broker && typeof broker.auth === 'function') {
    await broker.auth();
  }

  executor.init(state, trades);

  const openTrades = executor.getTradeLog().filter(t => !t.exitTime);
  
  if (openTrades.length === 0) {
    console.log('✓ No open positions to close');
    process.exit(0);
  }

  // Filter to target symbol if specified
  let candidates = openTrades;
  if (targetSymbol) {
    candidates = openTrades.filter(t => t.symbol === targetSymbol);
    if (candidates.length === 0) {
      console.log(`✓ No open positions for ${targetSymbol}`);
      process.exit(0);
    }
  }

  // Find the losing position with worst PnL
  let worstTrade = null;
  let worstPnL = 0;
  
  for (const trade of candidates) {
    const currentPrice = prices.getCurrentPrice(trade.symbol);
    if (!currentPrice) continue;

    const priceDiff = trade.direction === 'long'
      ? currentPrice - trade.entryPrice
      : trade.entryPrice - currentPrice;

    const pnl = priceDiff * trade.size;
    
    if (pnl < worstPnL) {
      worstPnL = pnl;
      worstTrade = trade;
    }
  }

  if (!worstTrade) {
    console.log('✓ No losing positions found');
    process.exit(0);
  }

  console.log(`\n🔴 Closing losing position:`);
  console.log(`   Symbol: ${worstTrade.symbol}`);
  console.log(`   Direction: ${worstTrade.direction}`);
  console.log(`   Entry: ${worstTrade.entryPrice}`);
  console.log(`   Current PnL: ${worstPnL.toFixed(2)} USD`);
  console.log(`   Size: ${worstTrade.size}`);

  // Close it
  const closed = executor.exit(worstTrade.symbol, 'manual');
  if (closed) {
    console.log(`\n✅ Position closed successfully`);
    console.log(`   Exit Price: ${closed.closePrice}`);
    console.log(`   Final PnL: ${closed.pnl.toFixed(2)} USD`);
    logger.writeJSON('trades.json', executor.getTradeLog());
  } else {
    console.log(`\n❌ Failed to close position`);
    process.exit(1);
  }

  process.exit(0);
}

const target = process.argv[2] || null;
closeLosingPosition(target)
  .catch(err => {
    console.error('ERROR:', err.message);
    process.exit(1);
  });
