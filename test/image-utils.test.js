const assert = require('node:assert/strict');
const test = require('node:test');
const {
  crc32Hex,
  parseAnthropicImage,
  parseOpenAIImage,
} = require('../src/image-utils');

function pngHeader(width = 32, height = 24) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('parses Anthropic base64 images', () => {
  const image = parseAnthropicImage({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: pngHeader().toString('base64'),
    },
  });

  assert.equal(image.mediaType, 'image/png');
  assert.equal(image.width, 32);
  assert.equal(image.height, 24);
});

test('parses OpenAI data URL images', () => {
  const image = parseOpenAIImage({
    type: 'image_url',
    image_url: {
      url: `data:image/png;base64,${pngHeader(40, 50).toString('base64')}`,
    },
  });

  assert.equal(image.width, 40);
  assert.equal(image.height, 50);
});

test('rejects remote image URLs', () => {
  assert.throws(
    () => parseOpenAIImage({
      type: 'image_url',
      image_url: { url: 'https://example.com/image.png' },
    }),
    /Remote image URLs are not supported/
  );
});

test('rejects images outside Trae dimensions', () => {
  assert.throws(
    () => parseAnthropicImage({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: pngHeader(13, 20).toString('base64'),
      },
    }),
    /at least 14x14/
  );
});

test('calculates Trae upload CRC32', () => {
  assert.equal(crc32Hex(Buffer.from('123456789')), 'cbf43926');
});
