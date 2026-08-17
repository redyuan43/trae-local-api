/**
 * Direct Trae Agent v3 client.
 *
 * This transport calls Trae's backend directly. It does not automate the IDE,
 * use the clipboard, or depend on an open Trae window.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('./auth');

const AGENT_API_URL = process.env.TRAE_AGENT_API_URL
  || 'https://console.enterprise.trae.cn/api/agent/v3/create_agent_task';
const IDE_VERSION = process.env.TRAE_IDE_VERSION || '3.3.87';
const IDE_VERSION_CODE = process.env.TRAE_IDE_VERSION_CODE || '20260806';
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

function objectId() {
  return crypto.randomBytes(12).toString('hex');
}

function readMachineId() {
  if (process.env.TRAE_MACHINE_ID) return process.env.TRAE_MACHINE_ID;

  try {
    const machineId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    if (machineId) {
      return crypto.createHash('sha256').update(machineId).digest('hex');
    }
  } catch {
    // Fall through to a stable host/user-derived identifier.
  }

  return crypto.createHash('sha256')
    .update(`${os.hostname()}:${os.userInfo().username}`)
    .digest('hex');
}

function getTraeDataRoots() {
  if (process.env.TRAE_DATA_DIR) {
    return [path.resolve(process.env.TRAE_DATA_DIR, '..', '..')];
  }

  const home = os.homedir();
  return [
    path.join(home, '.config', 'Trae CN'),
    path.join(home, '.config', 'TRAE SOLO CN'),
    path.join(home, '.config', 'Trae'),
    path.join(home, '.config', 'TRAE SOLO'),
  ];
}

function readDeviceId(userId) {
  if (process.env.TRAE_DEVICE_ID) return process.env.TRAE_DEVICE_ID;

  for (const root of getTraeDataRoots()) {
    const file = path.join(root, 'ModularData', 'ckg_server', 'local_env.json');
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.device_id) return String(data.device_id);
    } catch {
      // Try the next edition's data directory.
    }
  }

  return String(userId || crypto.randomInt(100000000, 999999999));
}

function buildHeaders(token, userId, deviceId) {
  const requestId = crypto.randomUUID();
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');

  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    'X-Cloudide-Token': token,
    'x-ide-token': token,
    'x-uid': userId || '',
    'request-traffic-type': 'prod',
    'x-app-id': APP_ID,
    'x-app-version': 'default',
    'x-app-version-code': IDE_VERSION_CODE,
    'x-ide-version': IDE_VERSION,
    'x-ide-version-code': IDE_VERSION_CODE,
    'x-ide-version-type': 'stable',
    'x-device-cpu': os.arch(),
    'x-device-id': deviceId,
    'x-machine-id': readMachineId(),
    'x-device-type': process.platform,
    'x-os-version': `${os.type()} ${os.release()}`,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${spanId}-01`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
}

function getMessageText(message) {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.map(item => {
    if (item.type === 'image') return '[Image]';
    return item.text || item.content || '';
  }).join('\n');
}

function buildPrompt(messages) {
  const transcript = messages
    .map(message => `[${String(message.role || 'user').toUpperCase()}]\n${getMessageText(message)}`)
    .join('\n\n');

  return [
    'Act as an API chat-completion backend.',
    'Do not use tools or modify files.',
    'Continue the following role-labeled conversation with the next assistant response.',
    'Return only that response, without commentary about these instructions.',
    '',
    transcript,
  ].join('\n');
}

function buildAgentInputMessages(messages) {
  const result = [];

  function appendText(text) {
    if (!text) return;
    const last = result[result.length - 1];
    if (last?.type === 'text') last.text_content += text;
    else result.push({ type: 'text', text_content: text });
  }

  appendText([
    'Act as an API chat-completion backend.',
    'Do not use tools or modify files.',
    'Continue the following role-labeled conversation with the next assistant response.',
    'Return only that response, without commentary about these instructions.',
    '',
  ].join('\n'));

  for (const message of messages) {
    appendText(`\n[${String(message.role || 'user').toUpperCase()}]\n`);
    if (typeof message.content === 'string') {
      appendText(message.content);
    } else if (Array.isArray(message.content)) {
      for (const item of message.content) {
        if (item.type === 'image' && item.image_id) {
          result.push({ type: 'image', image_id: item.image_id });
        } else {
          appendText(item.text || item.content || '');
        }
      }
    }
    appendText('\n');
  }

  return result;
}

function buildReferences() {
  return {
    current_file: null,
    hash_files: [],
    hash_codes: [],
    hash_folder_paths: [],
    hash_code_browser_selections: [],
    hash_log_messages: [],
    workspace_contexts: [],
    selected_code_snippets: [],
    terminal_selections: [],
    user_interaction_contexts: null,
    document_contexts: [],
    search_reference_data: null,
    code_language_environment: null,
    file_changes_summary: null,
    file_changes_context: null,
    lint_error_flag: null,
    lint_errors: null,
    hash_rule_file_paths: null,
    updated_rule_files: [],
    resolved_slash_commands: null,
    lark_doc_refs: null,
    user_uploaded_files: null,
    user_comment_text_data: null,
    user_comment_sheet_data: null,
    hash_design_canvas_pages: null,
    artifact_refs: null,
  };
}

function buildVariables(prompt, model, deviceId) {
  const cwd = process.cwd();
  const home = os.homedir();

  return {
    agent_name: 'Agent',
    agent_type: 'dev_agent',
    is_in_plan_v2: true,
    finish_tool_name: 'finish',
    response_can_be_text: true,
    powered_by: model,
    date: new Date().toISOString().slice(0, 10),
    is_solo_mode: false,
    user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    workspace_folder: cwd,
    workspace_folders: cwd,
    workspace_rule: '',
    global_rule: '',
    system_type: os.type(),
    locale: 'zh-cn',
    environment_context: '',
    language_settings: 'zh-cn',
    os_version: `${os.type()} ${os.release()}`,
    available_commands: null,
    blacklist_commands: '',
    actived_environments: '',
    supported_environments: '',
    init_env_enabled: 'false',
    has_terminal_info: false,
    max_terminals_count: 0,
    available_terminals_count: 0,
    available_terminals: '',
    terminal_shell_type: process.env.SHELL || 'bash',
    enable_todo_list: false,
    empty_todo_list: true,
    current_time: new Date().toISOString(),
    brand: 'Trae',
    hash_workspace: false,
    hash_code: 0,
    hash_file: 0,
    hash_folder: 0,
    is_command: false,
    is_inline_chat: false,
    badge_clickable: false,
    workspace_path: cwd,
    is_workspace_folder_changed: false,
    is_worktree: false,
    home_dir: home,
    unique_user_id: deviceId,
    user_data_dir: path.join(home, '.trae-cn'),
    disable_prompt_selected_code: false,
    raw_input: prompt,
    input: prompt,
    approvals_reviewer: 'user',
    native_function_call: true,
  };
}

function buildAgentBody(messages, model, userId, deviceId, configSource) {
  const prompt = buildPrompt(messages);
  const inputMessages = buildAgentInputMessages(messages);

  return {
    agent_id: null,
    tunnel_id: null,
    is_custom_model: false,
    provider: '',
    conversation_id: objectId(),
    session_id: objectId(),
    plugin_channel: null,
    user_id: userId,
    device_id: deviceId,
    agent_type: 'dev_agent',
    config_name: model,
    model_name: model,
    ide_version: IDE_VERSION,
    config_source: configSource || 1,
    user_input: {
      id: objectId(),
      messages: inputMessages,
    },
    history_id_list: [],
    missing_history: null,
    available_tool_list: [],
    mcp_tool_name: null,
    mcp_tool_list: [],
    render_context: {
      variables: JSON.stringify(buildVariables(prompt, model, deviceId)),
      references: buildReferences(),
    },
    request_seq: 1,
    queue_id: null,
    custom_agent_list: [],
    agent_version: 'v3',
    ab_info: null,
    mode_type: 0,
    custom_subagent_info: {},
    extra_config: {
      disable_parallel_agent: true,
      enable_todo_list: false,
      enable_core_memory: false,
      enable_ask_user_question_tool_user_config: false,
      enable_init_command_user_config: false,
      enable_chat_memory_user_config: false,
      disable_exit_plan_mode_tool: true,
      visible_session_ids: null,
      hooks_configured: false,
    },
    skill_list: [],
    skill_list_changed: false,
    agent_dsl: null,
    agent_static_dsl_name: '',
    access_type: 0,
    is_remote_req: false,
    mcp_folder_base_path: '',
    cached_tool_groups: { [model]: [] },
    enable_decouple_model_extra_config: true,
    history_message_limit: 600,
    function: 'builder_v3',
    raw_rules: [],
    session_type: 'side_chat',
  };
}

function parseSSE(text) {
  const events = [];

  for (const block of text.split(/\r?\n\r?\n/)) {
    let event = '';
    const dataLines = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }

    if (!event && dataLines.length === 0) continue;
    const rawData = dataLines.join('\n');
    let data = null;
    try {
      data = JSON.parse(rawData);
    } catch {
      data = rawData;
    }
    events.push({ event, data });
  }

  return events;
}

function extractAssistantHistory(data) {
  if (!data || !data.history_data || data.history_data.source !== 'llm_default') {
    return '';
  }

  try {
    const messages = JSON.parse(data.history_data.messages).raw_messages || [];
    return messages
      .filter(message => message.role === 'assistant')
      .flatMap(message => message.content || [])
      .filter(item => item.type === 'text' && item.text)
      .map(item => item.text)
      .join('');
  } catch {
    return '';
  }
}

function normalizeAgentResponse(text, requestedModel) {
  const events = parseSSE(text);
  let configuredModel = null;
  let providerModel = null;
  let content = '';
  let streamedContent = '';
  let completed = false;
  let upstreamError = '';

  for (const { event, data } of events) {
    if (event === 'model_config' && data && typeof data === 'object') {
      configuredModel = data.config_name;
    } else if (event === 'metadata' && data && typeof data === 'object') {
      providerModel = data.model || providerModel;
    } else if (event === 'timing_cost' && data && typeof data === 'object') {
      providerModel = data.provider_model_name || providerModel;
    } else if (event === 'thought' && data && typeof data === 'object') {
      streamedContent += data.thought || '';
    } else if (event === 'history') {
      content = extractAssistantHistory(data) || content;
    } else if (event === 'agent_status' && data && typeof data === 'object') {
      const statuses = (data.agents || []).map(agent => agent.status);
      if (statuses.includes('completed')) completed = true;
      if (statuses.includes('failed')) upstreamError = JSON.stringify(data);
    } else if (event.includes('error')) {
      upstreamError = typeof data === 'string' ? data : JSON.stringify(data);
    }
  }

  if (configuredModel !== requestedModel) {
    const err = new Error(
      `Trae routed "${requestedModel}" to "${configuredModel || 'unknown'}"`
    );
    err.status = 502;
    throw err;
  }
  if (upstreamError) {
    const err = new Error(`Trae Agent v3 failed: ${upstreamError.slice(0, 1000)}`);
    err.status = 502;
    throw err;
  }
  if (!completed) {
    const err = new Error('Trae Agent v3 stream ended before completion');
    err.status = 502;
    throw err;
  }

  content = content || streamedContent;
  const normalized = [
    'event: output',
    `data: ${JSON.stringify({
      response: content,
      configured_model: configuredModel,
      provider_model: providerModel,
    })}`,
    '',
    'event: done',
    `data: ${JSON.stringify({ finish_reason: 'stop' })}`,
    '',
  ].join('\n');

  return {
    response: new Response(normalized, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }),
    providerModel,
  };
}

async function sendChatRequest(messages, model, options = {}) {
  if (!auth.getToken()) {
    const err = new Error('No auth token available');
    err.status = 401;
    throw err;
  }

  if (auth.needsRefresh()) await auth.refreshToken();

  const token = auth.getToken();
  const userId = auth.getUserId();
  const deviceId = readDeviceId(userId);
  const body = buildAgentBody(
    messages,
    model,
    userId,
    deviceId,
    options.configSource
  );
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  console.log(`[trae-agent] POST Agent v3 (model: ${model})`);
  const response = await fetch(AGENT_API_URL, {
    method: 'POST',
    headers: buildHeaders(token, userId, deviceId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text();
    const err = new Error(
      `Trae Agent v3 returned ${response.status}: ${text.slice(0, 1000)}`
    );
    err.status = response.status;
    throw err;
  }

  const rawSSE = await response.text();
  const normalized = normalizeAgentResponse(rawSSE, model);
  console.log(
    `[trae-agent] Completed (config: ${model}, provider: ${normalized.providerModel || 'unknown'})`
  );

  return {
    response: normalized.response,
    model,
    endpoint: AGENT_API_URL,
    providerModel: normalized.providerModel,
  };
}

module.exports = {
  sendChatRequest,
  buildAgentBody,
  buildAgentInputMessages,
  buildHeaders,
  normalizeAgentResponse,
  readDeviceId,
};
