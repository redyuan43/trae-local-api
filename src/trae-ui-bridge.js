/**
 * Bridge exact-model requests through the already-running Trae CN IDE.
 *
 * Trae's legacy HTTP endpoint ignores exact model selection. The IDE itself
 * does select the requested model correctly, so this bridge serializes
 * requests through the existing chat window and returns the copied response.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const DEFAULT_MODEL = 'DeepSeek-V4-Flash-Official';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

let requestQueue = Promise.resolve();

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.message = `${command} failed: ${stderr.trim() || error.message}`;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function displayEnv() {
  return {
    ...process.env,
    DISPLAY: process.env.TRAE_UI_DISPLAY || process.env.DISPLAY || ':0',
  };
}

function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(item => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item && typeof item.content === 'string') return item.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function formatPrompt(messages, requestId) {
  const transcript = messages
    .map(message => {
      const role = String(message.role || 'user').toUpperCase();
      const content = normalizeContent(message.content);
      return content ? `[${role}]\n${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    `TRAE_LOCAL_API_REQUEST_ID: ${requestId}`,
    '请不要调用任何工具，不要修改文件，只在聊天中直接回答。',
    '请依据下面按角色标记的完整对话，生成下一条 assistant 回复。',
    '',
    transcript,
  ].join('\n');
}

async function setClipboard(text, env) {
  await new Promise((resolve, reject) => {
    const child = spawn('xclip', ['-selection', 'clipboard'], {
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`xclip failed with exit ${code}`));
    });
    child.stdin.end(text);
  });
}

async function getClipboard(env) {
  return execFileAsync('xclip', ['-selection', 'clipboard', '-o'], {
    env,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function findWindow(env) {
  const title = process.env.TRAE_UI_WINDOW_TITLE || 'TraeCode CN';
  const output = await execFileAsync('xdotool', ['search', '--name', title], { env });
  const ids = output.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) {
    throw new Error(`No running Trae window matched "${title}"`);
  }
  return ids[ids.length - 1];
}

async function getWindowGeometry(windowId, env) {
  const output = await execFileAsync(
    'xdotool',
    ['getwindowgeometry', '--shell', windowId],
    { env }
  );
  const values = Object.fromEntries(
    output.trim().split('\n').map(line => line.split('=', 2))
  );
  return {
    x: Number(values.X),
    y: Number(values.Y),
    width: Number(values.WIDTH),
    height: Number(values.HEIGHT),
  };
}

function latestRendererLog() {
  const root = path.join(os.homedir(), '.config', 'Trae CN', 'logs');
  const candidates = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.name === 'renderer.log') {
        const stat = fs.statSync(fullPath);
        candidates.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      }
    }
  }

  visit(root);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates[0]) throw new Error('Trae renderer.log was not found');
  return candidates[0].path;
}

async function waitForCompletion(logPath, startOffset, model, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let offset = startOffset;
  let buffered = '';

  while (Date.now() < deadline) {
    const stat = fs.statSync(logPath);
    if (stat.size > offset) {
      const length = stat.size - offset;
      const fd = fs.openSync(logPath, 'r');
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, offset);
      fs.closeSync(fd);
      offset = stat.size;
      buffered = (buffered + chunk.toString('utf8')).slice(-256 * 1024);

      const completionLines = buffered
        .split('\n')
        .filter(line => line.includes('code_comp_complete_shown'));
      const completed = completionLines.find(line => line.includes(`"chat_model":"${model}"`));
      if (completed) return;
      if (completionLines.length > 0) {
        const match = completionLines[0].match(/"chat_model":"([^"]+)"/);
        const actualModel = match ? match[1] : 'unknown';
        throw new Error(
          `Trae IDE used ${actualModel}; select ${model} in the existing Trae window`
        );
      }

      const responseError = buffered
        .split('\n')
        .find(line => line.includes('ChatStreamFrontResponseReporter')
          && !line.includes('"status":"Success"'));
      if (responseError) {
        throw new Error(`Trae IDE request failed: ${responseError.slice(-1000)}`);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for Trae IDE after ${Math.round(timeoutMs / 1000)}s`);
}

async function copyLatestResponse(windowId, geometry, sentinel, env) {
  const copyX = geometry.x + geometry.width - 84;
  // Trae sometimes inserts a rating panel below the answer. Probe the two
  // action-row positions observed with and without that panel, plus nearby
  // offsets to tolerate minor layout changes.
  const bottomOffsets = [220, 215, 225, 325, 320, 330, 315, 335, 345];

  for (const bottomOffset of bottomOffsets) {
    const copyY = geometry.y + geometry.height - bottomOffset;
    await execFileAsync('xdotool', [
      'mousemove', String(copyX), String(copyY),
      'click', '1',
    ], { env });
    await sleep(150);
    const content = await getClipboard(env).catch(() => '');
    if (content && content !== sentinel) return content.trim();
  }
  throw new Error('Trae response copy button did not update the clipboard');
}

async function runRequest(messages, model, options = {}) {
  if (model !== DEFAULT_MODEL) {
    throw new Error(`Trae UI bridge only supports ${DEFAULT_MODEL}, got ${model}`);
  }

  const env = displayEnv();
  const windowId = await findWindow(env);
  const geometry = await getWindowGeometry(windowId, env);
  const logPath = latestRendererLog();
  const logOffset = fs.statSync(logPath).size;
  const timeoutMs = Number(
    options.timeoutMs || process.env.TRAE_UI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS
  );
  const requestId = `${Date.now()}-${process.pid}`;
  const prompt = formatPrompt(messages, requestId);
  const sentinel = `TRAE_LOCAL_API_CLIPBOARD_${requestId}`;
  const previousClipboard = await getClipboard(env).catch(() => '');

  try {
    await execFileAsync('xdotool', ['windowactivate', '--sync', windowId], { env });
    await setClipboard(prompt, env);
    await sleep(250);

    const inputX = geometry.x + geometry.width - 440;
    const inputY = geometry.y + geometry.height - 145;
    await execFileAsync(
      'xdotool',
      ['mousemove', String(inputX), String(inputY), 'click', '1'],
      { env }
    );
    await sleep(150);
    await execFileAsync('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { env });
    await sleep(250);
    await execFileAsync('xdotool', ['key', '--clearmodifiers', 'Return'], { env });

    await sleep(500);
    await setClipboard(sentinel, env);
    await waitForCompletion(logPath, logOffset, model, timeoutMs);
    await sleep(300);
    return await copyLatestResponse(windowId, geometry, sentinel, env);
  } finally {
    await setClipboard(previousClipboard, env).catch(() => {});
  }
}

function sendChatRequest(messages, model, options) {
  const task = requestQueue.then(() => runRequest(messages, model, options));
  requestQueue = task.catch(() => {});
  return task;
}

function supportsModel(model) {
  return model === DEFAULT_MODEL;
}

module.exports = {
  DEFAULT_MODEL,
  formatPrompt,
  sendChatRequest,
  supportsModel,
};
