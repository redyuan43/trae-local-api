const assert = require('node:assert/strict');
const test = require('node:test');
const { buildUsageSummary } = require('../src/trae-usage-client');

test('builds precise currency usage and token estimates', () => {
  const summary = buildUsageSummary({
    Data: {
      ChatTotal: 500,
      ChatStartTime: 1000,
      ChatEndTime: 2000,
      ResetTime: 2001,
      TotalSeats: 5,
      TokenUsage: { CompletionUsageTokens: 100 },
    },
  }, {
    overview: {
      total_used_amount: '40',
      total_used_tokens: 2000,
      over_session_used_amount: '0',
    },
    items: [{
      model_used_quota_configs: [{
        config_name: 'model-a',
        display_name: 'Model A',
        money_usage: 40,
        token_usage: 2000,
      }],
    }],
  }, {
    items: [{
      display_name: 'Model A',
      tokens_usage: 4000,
      input_tokens: 3000,
      output_tokens: 1000,
      cache_input_tokens: 2400,
      cache_storage_tokens: 0,
      model_call_count: 2,
      total_cost_currency: 40,
      pre_discount_money_cost: 80,
    }],
  }, 1500);

  assert.equal(summary.billing.quota_amount, 500);
  assert.equal(summary.billing.used_amount, 40);
  assert.equal(summary.billing.remaining_amount, 460);
  assert.equal(summary.tokens.raw_total, 4000);
  assert.equal(summary.tokens.billed_total, 2000);
  assert.equal(summary.tokens.cache_hit_ratio, 0.8);
  assert.equal(summary.discount.effective_factor, 0.5);
  assert.equal(summary.estimate.remaining_tokens, 46000);
  assert.equal(summary.models[0].estimated_remaining_tokens, 46000);
});
