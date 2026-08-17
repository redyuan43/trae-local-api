const fs = require('fs');
const os = require('os');
const path = require('path');

const ENTERPRISE_BASE_URL = process.env.TRAE_ENTERPRISE_BASE_URL
  || 'https://console.enterprise.trae.cn';
const SESSION_FILE = process.env.TRAE_ENTERPRISE_SESSION_FILE
  || path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'trae-local-api',
    'enterprise-session.json'
  );
const UNLIMITED_QUOTA = 9999999999;

function usageError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function readEnterpriseSession() {
  if (process.env.TRAE_ENTERPRISE_SESSION) {
    return process.env.TRAE_ENTERPRISE_SESSION.trim();
  }

  let stored;
  try {
    stored = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw usageError(
        'Enterprise session is not configured. Run "npm run sync:enterprise-session".',
        503
      );
    }
    throw usageError(`Could not read enterprise session: ${error.message}`, 503);
  }

  if (!stored.cookie || typeof stored.cookie !== 'string') {
    throw usageError('Enterprise session file does not contain a valid cookie.', 503);
  }
  if (stored.expires_at && Date.parse(stored.expires_at) <= Date.now()) {
    throw usageError(
      'Enterprise session has expired. Run "npm run sync:enterprise-session".',
      503
    );
  }
  return stored.cookie;
}

async function postEnterprise(pathname, body, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const session = options.session || readEnterpriseSession();
  const response = await fetchImpl(`${ENTERPRISE_BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Cookie: `X-Cloudide-Tob-Session=${session}`,
    },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(options.timeoutMs || 15000),
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw usageError(`Trae usage API returned invalid JSON (${response.status}).`);
  }

  if (!response.ok) {
    throw usageError(
      `Trae usage API returned ${response.status}: ${payload.message || 'request failed'}`,
      response.status
    );
  }
  if (payload.code && payload.code !== 0) {
    const status = payload.code === 30011 ? 503 : 502;
    throw usageError(
      `Trae usage API failed: ${payload.message || payload.code}`,
      status
    );
  }
  return payload;
}

function summarizeDetails(items) {
  const totals = {
    sessions: items.length,
    model_calls: 0,
    raw_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_input_tokens: 0,
    cache_storage_tokens: 0,
    pre_discount_amount: 0,
    actual_amount: 0,
  };
  const models = new Map();

  for (const item of items) {
    const rawTokens = number(item.tokens_usage);
    const actualAmount = number(item.total_cost_currency);
    const displayName = item.display_name || item.model_name || 'Unknown';
    const model = models.get(displayName) || {
      model: displayName,
      raw_tokens: 0,
      model_calls: 0,
      actual_amount: 0,
    };

    totals.model_calls += number(item.model_call_count);
    totals.raw_tokens += rawTokens;
    totals.input_tokens += number(item.input_tokens);
    totals.output_tokens += number(item.output_tokens);
    totals.cache_input_tokens += number(item.cache_input_tokens);
    totals.cache_storage_tokens += number(item.cache_storage_tokens);
    totals.pre_discount_amount += number(item.pre_discount_money_cost);
    totals.actual_amount += actualAmount;

    model.raw_tokens += rawTokens;
    model.model_calls += number(item.model_call_count);
    model.actual_amount += actualAmount;
    models.set(displayName, model);
  }

  return {
    totals,
    models: Array.from(models.values()),
  };
}

function buildUsageSummary(corePayload, overviewPayload, detailPayload, now = Date.now()) {
  const core = corePayload.Data || {};
  const overview = overviewPayload.overview || {};
  const detailItems = detailPayload.items || [];
  const detail = summarizeDetails(detailItems);

  const periodStart = number(core.ChatStartTime);
  const periodEnd = number(core.ChatEndTime);
  const resetTime = number(core.ResetTime) || (periodEnd ? periodEnd + 1 : 0);
  const totalAmount = number(core.ChatTotal)
    || number(overview.seat_pool_per_user_money_quota) * number(core.TotalSeats);
  const usedAmount = number(overview.total_used_amount);
  const remainingAmount = Math.max(totalAmount - usedAmount, 0);
  const rawTokens = detail.totals.raw_tokens;
  const currentTokensPerYuan = usedAmount > 0 ? rawTokens / usedAmount : null;
  const estimatedRemainingTokens = currentTokensPerYuan
    ? Math.floor(remainingAmount * currentTokensPerYuan)
    : null;
  const reserveAmount = Math.min(50, totalAmount * 0.1);
  const conservativeAmount = Math.max(remainingAmount - reserveAmount, 0);

  const billedModels = new Map();
  for (const item of overviewPayload.items || []) {
    for (const model of item.model_used_quota_configs || []) {
      const key = model.display_name || model.config_name;
      const current = billedModels.get(key) || {
        model: key,
        config_name: model.config_name,
        billed_tokens: 0,
        actual_amount: 0,
      };
      current.billed_tokens += number(model.token_usage);
      current.actual_amount += number(model.money_usage);
      billedModels.set(key, current);
    }
  }

  const rawModels = new Map(detail.models.map(model => [model.model, model]));
  const modelNames = new Set([...billedModels.keys(), ...rawModels.keys()]);
  const models = Array.from(modelNames, modelName => {
    const billed = billedModels.get(modelName) || {};
    const raw = rawModels.get(modelName) || {};
    const modelAmount = number(billed.actual_amount || raw.actual_amount);
    const modelRawTokens = number(raw.raw_tokens);
    const effectiveCostPerMillion = modelRawTokens > 0
      ? modelAmount / modelRawTokens * 1_000_000
      : null;

    return {
      model: modelName,
      config_name: billed.config_name || null,
      raw_tokens: modelRawTokens,
      billed_tokens: number(billed.billed_tokens),
      model_calls: number(raw.model_calls),
      actual_amount: modelAmount,
      effective_cost_per_million_tokens: effectiveCostPerMillion,
      estimated_remaining_tokens: effectiveCostPerMillion
        ? Math.floor(remainingAmount / effectiveCostPerMillion * 1_000_000)
        : null,
    };
  }).sort((a, b) => b.actual_amount - a.actual_amount);

  return {
    status: 'ok',
    generated_at: new Date(now).toISOString(),
    billing: {
      unit: 'CNY',
      period_start: periodStart ? new Date(periodStart).toISOString() : null,
      period_end: periodEnd ? new Date(periodEnd).toISOString() : null,
      reset_at: resetTime ? new Date(resetTime).toISOString() : null,
      seats: number(core.TotalSeats),
      quota_amount: totalAmount,
      used_amount: usedAmount,
      remaining_amount: remainingAmount,
      used_ratio: ratio(usedAmount, totalAmount),
      remaining_ratio: ratio(remainingAmount, totalAmount),
      over_session_used_amount: number(overview.over_session_used_amount),
      boost_pack_used_amount: number(overview.boost_pack_used_amount),
      pay_as_you_go_used_amount: number(overview.pay_as_you_go_used_amount),
    },
    tokens: {
      sessions: detail.totals.sessions,
      model_calls: detail.totals.model_calls,
      raw_total: rawTokens,
      billed_total: number(overview.total_used_tokens),
      input: detail.totals.input_tokens,
      output: detail.totals.output_tokens,
      cache_input: detail.totals.cache_input_tokens,
      cache_storage: detail.totals.cache_storage_tokens,
      cache_hit_ratio: ratio(
        detail.totals.cache_input_tokens,
        detail.totals.input_tokens
      ),
      cue: number(core.TokenUsage?.CompletionUsageTokens),
    },
    discount: {
      pre_discount_amount: detail.totals.pre_discount_amount,
      actual_amount: usedAmount,
      effective_factor: ratio(usedAmount, detail.totals.pre_discount_amount),
    },
    estimate: {
      method: 'current_billing_period_effective_cost',
      tokens_per_yuan: currentTokensPerYuan,
      remaining_tokens: estimatedRemainingTokens,
      conservative_reserve_amount: reserveAmount,
      conservative_remaining_tokens: currentTokensPerYuan
        ? Math.floor(conservativeAmount * currentTokensPerYuan)
        : null,
      note: 'Token estimates vary with model, input/output mix, discounts, and cache hits.',
    },
    models,
  };
}

async function getUsageCosts(options = {}) {
  const session = options.session || readEnterpriseSession();
  const requestOptions = { ...options, session };
  const [corePayload, overviewPayload] = await Promise.all([
    postEnterprise(
      '/trae/gtm/tob/api/v1/config/get_personal_core_data',
      {},
      requestOptions
    ),
    postEnterprise(
      '/trae/gtm/tob/api/v1/config/get_trae_builtin_model_usage',
      {},
      requestOptions
    ),
  ]);

  const core = corePayload.Data || {};
  const startTime = options.startTime || number(core.ChatStartTime);
  const endTime = options.endTime
    || Math.min(Date.now(), number(core.ChatEndTime) || Date.now());
  const detailBody = { start_time: startTime, end_time: endTime };

  let detailPayload;
  try {
    detailPayload = await postEnterprise(
      '/trae/gtm/tob/api/v1/config/get_tenant_token_usage_detail',
      detailBody,
      requestOptions
    );
  } catch (error) {
    if (error.status === 503) throw error;
    detailPayload = await postEnterprise(
      '/trae/gtm/tob/api/v1/config/get_user_token_usage_detail',
      detailBody,
      requestOptions
    );
  }

  return buildUsageSummary(corePayload, overviewPayload, detailPayload);
}

module.exports = {
  ENTERPRISE_BASE_URL,
  SESSION_FILE,
  UNLIMITED_QUOTA,
  buildUsageSummary,
  getUsageCosts,
  readEnterpriseSession,
};
