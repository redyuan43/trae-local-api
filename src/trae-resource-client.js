const crypto = require('crypto');
const auth = require('./auth');
const { crc32Hex } = require('./image-utils');
const { buildHeaders, readDeviceId } = require('./trae-agent-client');

const RESOURCE_API_BASE = process.env.TRAE_RESOURCE_API_BASE
  || 'https://console.enterprise.trae.cn';
const DEFAULT_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

function upstreamError(message, status = 502) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function parseJsonResponse(response, stage) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw upstreamError(
      `Trae image ${stage} returned invalid JSON (${response.status})`
    );
  }

  if (!response.ok) {
    throw upstreamError(
      `Trae image ${stage} returned ${response.status}: ${text.slice(0, 500)}`,
      response.status
    );
  }
  if (payload.code && payload.code !== 0) {
    throw upstreamError(
      `Trae image ${stage} failed: ${payload.message || payload.code}`
    );
  }
  return payload.data || payload;
}

async function postResource(path, body, credentials, fetchImpl, timeoutMs) {
  const headers = {
    ...buildHeaders(credentials.token, credentials.userId, credentials.deviceId),
    Accept: 'application/json',
  };

  const response = await fetchImpl(`${RESOURCE_API_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseJsonResponse(response, path);
}

async function uploadImage(image, options = {}) {
  if (!auth.getToken()) {
    throw upstreamError('No auth token available', 401);
  }
  if (auth.needsRefresh()) await auth.refreshToken();

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_UPLOAD_TIMEOUT_MS;
  const userId = auth.getUserId();
  const credentials = {
    token: auth.getToken(),
    userId,
    deviceId: readDeviceId(userId),
  };
  const target = `${crypto.randomUUID().replace(/-/g, '')}_${image.width}x${image.height}.trae`;

  const prepared = await postResource(
    '/api/ide/v1/get_resource_upload_url',
    {
      targets: [target],
      biz_type: 'image',
      scale_param: { width: image.width, height: image.height },
    },
    credentials,
    fetchImpl,
    timeoutMs
  );

  const host = prepared.upload_hosts?.[0];
  const storeInfo = prepared.store_infos?.[0];
  if (!host || !storeInfo?.store_uri) {
    throw upstreamError('Trae image prepare returned incomplete upload information');
  }

  const storeUri = storeInfo.store_uri;
  const uploadUrl = `https://${host}/${storeUri.replace(/^\/+/, '')}`;
  const uploadHeaders = {
    Authorization: storeInfo.auth || '',
    'Content-CRC32': crc32Hex(image.buffer),
    'Content-Type': image.mediaType,
  };
  if (userId) uploadHeaders['X-Storage-U'] = encodeURIComponent(userId);

  const uploaded = await fetchImpl(uploadUrl, {
    method: 'PUT',
    headers: uploadHeaders,
    body: image.buffer,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!uploaded.ok) {
    const text = await uploaded.text().catch(() => '');
    throw upstreamError(
      `Trae image upload returned ${uploaded.status}: ${text.slice(0, 500)}`
    );
  }

  if (prepared.session_key) {
    await postResource(
      '/api/ide/v1/commit_resource_upload_result',
      {
        oids: [storeUri],
        session_key: prepared.session_key,
        biz_type: 'image',
      },
      credentials,
      fetchImpl,
      timeoutMs
    );
  }

  const resourceId = storeInfo.override_resource_id || storeUri;
  console.log(
    `[trae-resource] Uploaded image ${image.mediaType} ${image.width}x${image.height} `
    + `${image.buffer.length} bytes -> ${resourceId}`
  );
  return resourceId;
}

module.exports = {
  RESOURCE_API_BASE,
  uploadImage,
};
