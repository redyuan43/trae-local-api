const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { SESSION_FILE } = require('../src/trae-usage-client');

const COOKIE_NAME = 'X-Cloudide-Tob-Session';

function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate));
}

function defaultProfile() {
  return process.env.CHROME_PROFILE_DIR
    || path.join(os.homedir(), '.config', 'google-chrome', 'Default');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForTarget(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find(item => item.type === 'page');
      if (target?.webSocketDebuggerUrl) return target;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Timed out waiting for the temporary Chrome process');
}

function cdpCall(socket, state, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++state.id;
    state.pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function readCookieFromChrome(profileDir) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome or Chromium was not found');

  const userDataDir = path.dirname(profileDir);
  const profileName = path.basename(profileDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-session-'));
  const tempProfile = path.join(tempDir, profileName);
  fs.mkdirSync(tempProfile, { recursive: true });

  fs.copyFileSync(path.join(userDataDir, 'Local State'), path.join(tempDir, 'Local State'));
  fs.copyFileSync(path.join(profileDir, 'Cookies'), path.join(tempProfile, 'Cookies'));
  const preferences = path.join(profileDir, 'Preferences');
  if (fs.existsSync(preferences)) {
    fs.copyFileSync(preferences, path.join(tempProfile, 'Preferences'));
  }

  const port = await freePort();
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    `--profile-directory=${profileName}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const target = await waitForTarget(port);
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const state = { id: 0, pending: new Map() };
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      const pending = state.pending.get(message.id);
      if (!pending) return;
      state.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const result = await cdpCall(socket, state, 'Network.getAllCookies');
    socket.close();
    const cookie = result.cookies.find(item =>
      item.name === COOKIE_NAME
      && item.domain.endsWith('console.enterprise.trae.cn')
    );
    if (!cookie?.value) {
      throw new Error(
        'No TRAE enterprise session was found in this Chrome profile. '
        + 'Log in to console.enterprise.trae.cn first.'
      );
    }
    return cookie;
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 4) {
          console.warn(`Could not remove temporary Chrome profile: ${error.message}`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
  }
}

async function main() {
  const cookie = await readCookieFromChrome(defaultProfile());
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({
    cookie: cookie.value,
    expires_at: new Date(cookie.expires * 1000).toISOString(),
    synced_at: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(SESSION_FILE, 0o600);
  console.log(`Enterprise session synced to ${SESSION_FILE}`);
  console.log(`Session expires at ${new Date(cookie.expires * 1000).toISOString()}`);
}

main().catch(error => {
  console.error(`Could not sync enterprise session: ${error.message}`);
  process.exitCode = 1;
});
