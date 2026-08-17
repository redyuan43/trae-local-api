const assert = require('node:assert/strict');
const test = require('node:test');
const auth = require('../src/auth');
const { uploadImage } = require('../src/trae-resource-client');

test('uploads and commits an image through Trae resource HTTP APIs', async () => {
  const originals = {
    getToken: auth.getToken,
    getUserId: auth.getUserId,
    needsRefresh: auth.needsRefresh,
  };
  auth.getToken = () => 'test-token';
  auth.getUserId = () => 'test-user';
  auth.needsRefresh = () => false;

  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/get_resource_upload_url')) {
      return new Response(JSON.stringify({
        data: {
          upload_hosts: ['upload.example.test'],
          store_infos: [{
            auth: 'storage-auth',
            store_uri: '/stored/image',
            override_resource_id: 'resource-image-id',
          }],
          session_key: 'session-key',
        },
      }), { status: 200 });
    }
    if (url === 'https://upload.example.test/stored/image') {
      return new Response('', { status: 200 });
    }
    if (url.endsWith('/commit_resource_upload_result')) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  try {
    const resourceId = await uploadImage({
      buffer: Buffer.from('123456789'),
      mediaType: 'image/png',
      width: 32,
      height: 24,
    }, { fetchImpl });

    assert.equal(resourceId, 'resource-image-id');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].options.headers.Authorization, 'storage-auth');
    assert.equal(calls[1].options.headers['Content-CRC32'], 'cbf43926');

    const prepareBody = JSON.parse(calls[0].options.body);
    assert.equal(prepareBody.biz_type, 'image');
    assert.deepEqual(prepareBody.scale_param, { width: 32, height: 24 });

    const commitBody = JSON.parse(calls[2].options.body);
    assert.deepEqual(commitBody.oids, ['/stored/image']);
    assert.equal(commitBody.session_key, 'session-key');
  } finally {
    Object.assign(auth, originals);
  }
});
