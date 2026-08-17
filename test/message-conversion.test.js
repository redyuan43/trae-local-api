const assert = require('node:assert/strict');
const test = require('node:test');
const {
  convertAnthropicMessages,
  convertOpenAIMessages,
} = require('../src/server');

function imageData(width = 32, height = 24) {
  const buffer = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString('base64');
}

test('preserves OpenAI text and image order', () => {
  const converted = convertOpenAIMessages([{
    role: 'user',
    content: [
      { type: 'text', text: 'before' },
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${imageData()}` },
      },
      { type: 'text', text: 'after' },
    ],
  }]);

  assert.equal(converted.length, 1);
  assert.deepEqual(
    converted[0].content.map(block => block.type),
    ['text', 'image', 'text']
  );
  assert.match(converted[0].content[0].text, /before/);
  assert.match(converted[0].content[2].text, /after/);
});

test('preserves Anthropic text and image order', () => {
  const converted = convertAnthropicMessages([{
    role: 'user',
    content: [
      { type: 'text', text: 'inspect' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: imageData(),
        },
      },
    ],
  }]);

  assert.deepEqual(
    converted[0].content.map(block => block.type),
    ['text', 'image']
  );
});

test('rejects more than five images', () => {
  const image = {
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${imageData()}` },
  };
  assert.throws(
    () => convertOpenAIMessages([{
      role: 'user',
      content: Array.from({ length: 6 }, () => image),
    }]),
    /at most 5 images/
  );
});

test('rejects images in system messages', () => {
  assert.throws(
    () => convertAnthropicMessages([], [{
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: imageData(),
      },
    }]),
    /system messages/
  );
});
