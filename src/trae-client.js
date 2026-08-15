/**
 * Trae model catalog and direct Agent v3 chat client.
 */

const crypto = require('crypto');
const auth = require('./auth');
const traeAgentClient = require('./trae-agent-client');

const IDE_VERSION_CN = '3.3.87';
const IDE_VERSION_CODE_CN = '20260806';
const MODEL_CATALOG_URL = process.env.TRAE_MODEL_CATALOG_URL
  || 'https://console.enterprise.trae.cn/api/ide/v1/batch_get_detail_param';
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

let modelCatalogCache = null;
let modelCatalogCachedAt = 0;

const MODEL_MAP = {
  'claude-opus-4-7': 'DeepSeek-V4-Flash-Official',
  'claude-opus-4-6': 'DeepSeek-V4-Flash-Official',
  'claude-opus-4-5': 'DeepSeek-V4-Flash-Official',
  'claude-sonnet-4-6': 'DeepSeek-V4-Flash-Official',
  'claude-sonnet-4-5': 'DeepSeek-V4-Flash-Official',
  'claude-sonnet-4': 'DeepSeek-V4-Flash-Official',
  'claude-3.5-sonnet': 'DeepSeek-V4-Flash-Official',
  'claude-3.7-sonnet': 'DeepSeek-V4-Flash-Official',
  'claude-haiku-4-5': 'DeepSeek-V4-Flash-Official',
  'mimo-v2.5-pro': 'DeepSeek-V4-Flash-Official',
  'mimo-v2.5': 'DeepSeek-V4-Flash-Official',
  'gpt-4o': 'deepseek-V4-Pro',
  'gpt-4o-mini': 'DeepSeek-V4-Flash-Official',
  'gpt-4.1': 'deepseek-V4-Pro',
  auto: 'DeepSeek-V4-Flash-Official',
};

const MODEL_TIERS = {
  T1: ['glm-5.2'],
  T2: ['glm-5.1', 'qwen-3.7-plus', 'kimi-k2.6', 'deepseek-V4-Pro'],
  T3: ['glm-5', 'qwen-3.6-plus', 'minimax-m3', 'DeepSeek-V4-Flash-Official'],
  T4: ['glm-4.7', 'kimi-k2', 'qwen3-coder', 'minimax-m2.7'],
  T5: ['glm-4.6', 'minimax-m2.1'],
};

function buildCatalogHeaders(token, userId) {
  const requestId = crypto.randomUUID();
  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-ide-token': token,
    'x-uid': userId || '',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-app-version': 'default',
    'x-app-version-code': IDE_VERSION_CODE_CN,
    'x-ide-version': IDE_VERSION_CN,
    'x-ide-version-code': IDE_VERSION_CODE_CN,
    'x-ide-version-type': 'stable',
    'x-device-type': process.platform,
    'x-os-version': process.platform,
    'x-request-id': requestId,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function mapModel(requestedModel) {
  return MODEL_MAP[requestedModel] || requestedModel;
}

function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += ch.charCodeAt(0) > 0x2000 ? 1.5 : 0.25;
  }
  return Math.ceil(tokens);
}

function getMessageContent(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map(item => item.text || item.content || '').join(' ');
}

function truncateMessages(messages, maxTokens) {
  const limit = maxTokens
    || parseInt(process.env.MAX_CONTEXT_TOKENS || '90000', 10);
  const total = messages.reduce(
    (sum, message) => sum + estimateTokens(getMessageContent(message)),
    0
  );
  if (total <= limit) return messages;

  const result = [];
  let used = 0;
  let startIndex = 0;

  if (messages[0] && messages[0].role === 'system') {
    result.push(messages[0]);
    used = estimateTokens(getMessageContent(messages[0]));
    startIndex = 1;
  }

  const recent = [];
  for (let index = messages.length - 1; index >= startIndex; index--) {
    const tokens = estimateTokens(getMessageContent(messages[index]));
    if (used + tokens > limit && recent.length > 0) break;
    recent.unshift(messages[index]);
    used += tokens;
  }

  if (recent.length < messages.length - startIndex) {
    result.push({
      role: 'system',
      content: '[Earlier messages were truncated to fit the model context window.]',
    });
  }
  result.push(...recent);
  console.log(
    `[trae-client] Context truncated: ${messages.length} -> ${result.length} messages`
  );
  return result;
}

async function fetchModelCatalog() {
  if (modelCatalogCache && Date.now() - modelCatalogCachedAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache;
  }

  const token = auth.getToken();
  if (!token) {
    const err = new Error('No auth token available');
    err.status = 401;
    throw err;
  }

  const response = await fetch(MODEL_CATALOG_URL, {
    method: 'POST',
    headers: buildCatalogHeaders(token, auth.getUserId()),
    body: JSON.stringify({
      functions: ['chat_v3', 'builder_v3'],
      agent_type: 'dev_agent',
      current_config_info: { config_name: '', is_custom_model: false },
      mode_type: 0,
      access_type: 0,
      ab_force_vids: '',
      ab_autotest_advanced_mode: 0,
      show_custom_model: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(
      `Trae model catalog returned ${response.status}: ${text.slice(0, 500)}`
    );
    err.status = response.status;
    throw err;
  }

  modelCatalogCache = await response.json();
  modelCatalogCachedAt = Date.now();
  return modelCatalogCache;
}

function getCatalogConfigs(catalog) {
  const functions = catalog.function_configs || [];
  const builder = functions.find(item => item.function === 'builder_v3');
  const chat = functions.find(item => item.function === 'chat_v3');
  return (builder || chat || {}).config_info_list || [];
}

async function resolveConfig(model) {
  try {
    const catalog = await fetchModelCatalog();
    return getCatalogConfigs(catalog).find(config => config.config_name === model) || null;
  } catch (err) {
    console.warn(`[trae-client] Could not resolve model catalog: ${err.message}`);
    return null;
  }
}

async function sendChatRequest(messages, model, stream, options = {}) {
  const traeModel = mapModel(model);
  const config = await resolveConfig(traeModel);

  if (config && config.config_switch === false) {
    const err = new Error(`Trae model "${traeModel}" is disabled for this account`);
    err.status = 400;
    throw err;
  }

  return traeAgentClient.sendChatRequest(
    truncateMessages(messages),
    traeModel,
    {
      ...options,
      configSource: config ? config.config_source : 1,
    }
  );
}

async function getModels() {
  const catalog = await fetchModelCatalog();
  const configs = getCatalogConfigs(catalog);
  const created = Math.floor(Date.now() / 1000);

  return configs
    .filter(config => config.config_switch !== false)
    .map(config => {
      const details = config.model_detail_list || [];
      const dev = details.find(detail => detail.model_name.endsWith('__dev')) || details[0];
      const max = details.find(detail => detail.model_name.endsWith('__max'));

      return {
        id: config.config_name,
        object: 'model',
        created,
        owned_by: 'trae',
        display_name: config.display_config?.display_name || config.config_name,
        config_source: config.config_source,
        internal_model: dev?.model_name || null,
        max_internal_model: max?.model_name || null,
        context_window: dev?.prompt_max_tokens || null,
        max_output_tokens: dev?.max_tokens || null,
        selectable_in_ide: true,
        selectable_via_agent_api: true,
      };
    });
}

module.exports = {
  sendChatRequest,
  getModels,
  mapModel,
  MODEL_MAP,
  MODEL_TIERS,
};
