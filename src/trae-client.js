/**
 * trae-client.js - Trae API client
 *
 * The legacy lightweight endpoint is OpenAI-compatible enough for basic chat,
 * but it does not reliably honor the request's model field. Trae IDE model
 * selection is resolved by the stateful Agent v3 task protocol.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const auth = require('./auth');

const IDE_VERSION_CN = '3.3.87';
const IDE_VERSION_CODE_CN = '20260806';
const MODEL_CATALOG_URL = process.env.TRAE_MODEL_CATALOG_URL
  || 'https://console.enterprise.trae.cn/api/ide/v1/batch_get_detail_param';
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
const VERIFIED_LEGACY_MODEL = 'kimi-k2.6';

let modelCatalogCache = null;
let modelCatalogCachedAt = 0;

// Model name mapping: external name -> Trae internal name
const MODEL_MAP = {
  // Claude -> GLM-5.2 (T1 flagship)
  'claude-opus-4-7': 'glm-5.2',
  'claude-opus-4-6': 'glm-5.2',
  'claude-opus-4-5': 'glm-5.2',
  'claude-sonnet-4-6': 'glm-5.2',
  'claude-sonnet-4-5': 'glm-5.2',
  'claude-sonnet-4': 'glm-5.2',
  'claude-3.5-sonnet': 'glm-5.2',
  'claude-3.7-sonnet': 'glm-5.2',
  'claude-haiku-4-5': 'glm-5.1',
  // Claude Code internal models
  'mimo-v2.5-pro': 'glm-5.2',
  'mimo-v2.5': 'glm-5.2',
  // GPT -> DeepSeek
  'gpt-4o': 'deepseek-V4-Pro',
  'gpt-4o-mini': 'DeepSeek-V4-Flash',
  'gpt-4.1': 'deepseek-V4-Pro',
  // The legacy endpoint currently resolves its default route to Kimi K2.6.
  'auto': VERIFIED_LEGACY_MODEL,
};

// Model tiers for fallback
const MODEL_TIERS = {
  T1: ['glm-5.2'],
  T2: ['glm-5.1', 'qwen-3.7-plus', 'kimi-k2.6', 'deepseek-V4-Pro'],
  T3: ['glm-5', 'qwen-3.6-plus', 'minimax-m3', 'DeepSeek-V4-Flash'],
  T4: ['glm-4.7', 'kimi-k2', 'qwen3-coder', 'minimax-m2.7'],
  T5: ['glm-4.6', 'minimax-m2.1'],
};

// Reverse: find tier for a model
function getTier(model) {
  for (const [tier, models] of Object.entries(MODEL_TIERS)) {
    if (models.includes(model)) return tier;
  }
  return null;
}

function hashDeviceId(machineId) {
  return crypto.createHash('sha256').update(machineId).digest('hex').substring(0, 32);
}

function generateMachineId() {
  return crypto.randomBytes(32).toString('hex');
}

function buildHeaders(token, userId) {
  const machineId = generateMachineId();
  const requestId = crypto.randomUUID();
  return {
    'Authorization': `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-uid': userId || '',
    'x-app-id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'x-device-id': hashDeviceId(machineId),
    'x-machine-id': machineId,
    'x-request-id': requestId,
    'x-app-version': 'default',
    'x-app-version-code': IDE_VERSION_CODE_CN,
    'x-ide-version': IDE_VERSION_CN,
    'x-ide-version-code': IDE_VERSION_CODE_CN,
    'x-ide-version-type': 'stable',
    'x-device-type': process.platform,
    'x-os-version': process.platform,
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  };
}

function mapModel(requestedModel) {
  const mapped = MODEL_MAP[requestedModel];
  if (mapped) return mapped;
  // If not in map, pass through as-is
  return requestedModel;
}

/**
 * Estimate token count from text (rough: ~4 chars per token for mixed CJK/English)
 */
function estimateTokens(text) {
  if (!text) return 0;
  // CJK characters ~1.5 tokens each, ASCII ~0.25 tokens per char
  let tokens = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code > 0x2000) {
      tokens += 1.5; // CJK and other wide chars
    } else {
      tokens += 0.25; // ASCII
    }
  }
  return Math.ceil(tokens);
}

/**
 * Get content string from a message
 */
function getMessageContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map(b => b.text || b.content || '').join(' ');
  }
  return '';
}

/**
 * Smart context truncation: keep system message + recent messages
 * to fit within the target token budget
 * Configure via MAX_CONTEXT_TOKENS env var (default: 16000)
 */
function truncateMessages(messages, maxTokens) {
  if (!maxTokens) {
    maxTokens = parseInt(process.env.MAX_CONTEXT_TOKENS || '200000', 10);
  }
  if (messages.length === 0) return messages;

  // Calculate total tokens
  let totalTokens = 0;
  for (const m of messages) {
    totalTokens += estimateTokens(getMessageContent(m));
  }

  if (totalTokens <= maxTokens) return messages;

  console.log(`[trae-client] Context truncation: ${totalTokens} est. tokens > ${maxTokens} limit`);

  // Keep system message (first message if it's system role)
  const result = [];
  let startIdx = 0;

  if (messages[0] && messages[0].role === 'system') {
    result.push(messages[0]);
    startIdx = 1;
    totalTokens = estimateTokens(getMessageContent(messages[0]));
  }

  // Add messages from the end (most recent first), until we hit the limit
  const recentMessages = [];
  for (let i = messages.length - 1; i >= startIdx; i--) {
    const msgTokens = estimateTokens(getMessageContent(messages[i]));
    if (totalTokens + msgTokens > maxTokens && recentMessages.length > 0) {
      console.log(`[trae-client] Truncated: kept ${result.length + recentMessages.length}/${messages.length} messages`);
      break;
    }
    recentMessages.unshift(messages[i]);
    totalTokens += msgTokens;
  }

  // Insert a marker if we truncated
  if (recentMessages.length < messages.length - startIdx) {
    const dropped = messages.length - startIdx - recentMessages.length;
    result.push({
      role: 'system',
      content: `[Note: ${dropped} earlier messages were truncated to fit context window]`,
    });
  }

  result.push(...recentMessages);
  console.log(`[trae-client] Final messages: ${result.length}, ~${totalTokens} tokens`);
  return result;
}

/**
 * Build Trae chat request body
 * Each request gets a unique session_id to isolate conversations
 * @param {Array} messages - 消息列表
 * @param {string} model - 模型名
 * @param {boolean} stream - 是否流式
 * @param {object} options - 额外选项 { maxTokens }
 */
function buildChatBody(messages, model, stream, options) {
  // Truncate context to avoid hitting API limits
  const truncated = truncateMessages(messages);

  // Generate unique session/request ID to prevent cross-session contamination
  const sessionId = crypto.randomUUID();

  const body = {
    messages: truncated.map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }]
        : m.content,
    })),
    model: model,
    function: 'inline_chat',
    stream: stream !== false,
    request_id: sessionId,
    session_id: sessionId,
  };

  // 透传 max_tokens(若上游支持)
  const maxTokens = options && options.maxTokens;
  if (maxTokens && typeof maxTokens === 'number' && maxTokens > 0) {
    body.max_tokens = maxTokens;
  }

  return body;
}

/**
 * Send chat request with 3-level endpoint fallback
 * Returns a readable stream of SSE events
 * @param {Array} messages - 消息列表
 * @param {string} model - 模型名
 * @param {boolean} stream - 是否流式
 * @param {string} baseUrl - 上游 base URL
 * @param {object} options - 额外选项 { maxTokens }
 */
async function sendChatRequest(messages, model, stream, baseUrl, options) {
  const token = auth.getToken();
  const userId = auth.getUserId();

  if (!token) {
    const err = new Error('No auth token available');
    err.status = 401;
    throw err;
  }

  // Check if token needs refresh
  if (auth.needsRefresh()) {
    await auth.refreshToken();
  }

  const traeModel = mapModel(model);

  if (traeModel !== VERIFIED_LEGACY_MODEL
      && process.env.ALLOW_UNVERIFIED_MODEL_ROUTING !== 'true') {
    const err = new Error(
      `Trae legacy chat endpoint cannot reliably select "${traeModel}". `
      + `It currently routes requests to ${VERIFIED_LEGACY_MODEL} regardless of the model field. `
      + 'Use the Trae IDE Agent protocol for exact model selection, or set '
      + 'ALLOW_UNVERIFIED_MODEL_ROUTING=true only for compatibility testing.'
    );
    err.status = 400;
    throw err;
  }

  const body = buildChatBody(messages, traeModel, stream, options);
  const headers = buildHeaders(auth.getToken(), userId);

  // 3-level endpoint fallback
  const endpoints = [
    '/api/agent/v3/llm_utils_chat',
    '/api/ide/v1/chat',
    '/api/agent/v3/create_agent_task',
  ];

  let lastError = null;
  let lastStatus = 502;

  for (const endpoint of endpoints) {
    const url = `${baseUrl}${endpoint}`;
    console.log(`[trae-client] Trying endpoint: ${endpoint} (model: ${traeModel})`);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (resp.ok) {
        console.log(`[trae-client] Success with endpoint: ${endpoint}`);
        return { response: resp, model: traeModel, endpoint };
      }

      const text = await resp.text();
      console.warn(`[trae-client] Endpoint ${endpoint} returned ${resp.status}: ${text.substring(0, 500)}`);
      console.warn(`[trae-client] Request body was: ${JSON.stringify(body).substring(0, 500)}`);
      const err = new Error(`${endpoint}: ${resp.status} ${text.substring(0, 500)}`);
      err.status = resp.status;
      err.endpoint = endpoint;
      lastError = err;
      lastStatus = resp.status;
    } catch (err) {
      console.warn(`[trae-client] Endpoint ${endpoint} error: ${err.message}`);
      err.status = err.status || 502;
      lastError = err;
      lastStatus = err.status;
    }
  }

  // 确保抛出的错误对象携带 status 字段,供 server.js 做状态码映射
  if (lastError) {
    lastError.status = lastStatus;
    throw lastError;
  }
  throw new Error('All endpoints failed');
}

/**
 * Fetch the model configurations currently enabled for this Trae account.
 */
async function fetchModelCatalog() {
  if (modelCatalogCache && Date.now() - modelCatalogCachedAt < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache;
  }

  const token = auth.getToken();
  const userId = auth.getUserId();
  if (!token) {
    const err = new Error('No auth token available');
    err.status = 401;
    throw err;
  }

  const headers = buildHeaders(token, userId);
  headers.Accept = 'application/json';

  const resp = await fetch(MODEL_CATALOG_URL, {
    method: 'POST',
    headers,
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

  if (!resp.ok) {
    const text = await resp.text();
    const err = new Error(`Trae model catalog returned ${resp.status}: ${text.substring(0, 500)}`);
    err.status = resp.status;
    throw err;
  }

  modelCatalogCache = await resp.json();
  modelCatalogCachedAt = Date.now();
  return modelCatalogCache;
}

/**
 * Get available models from Trae.
 *
 * These entries describe what the IDE account can select. Only entries marked
 * selectable_via_legacy_api are verified to work through this proxy's current
 * lightweight chat transport.
 */
async function getModels() {
  const catalog = await fetchModelCatalog();
  const chatConfig = (catalog.function_configs || [])
    .find(item => item.function === 'chat_v3');
  const configs = chatConfig ? chatConfig.config_info_list || [] : [];
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
        selectable_via_legacy_api: config.config_name === VERIFIED_LEGACY_MODEL,
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
