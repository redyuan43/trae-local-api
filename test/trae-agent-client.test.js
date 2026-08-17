const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAgentBody,
  buildAgentInputMessages,
} = require('../src/trae-agent-client');

const messages = [{
  role: 'user',
  content: [
    { type: 'text', text: 'What is shown?' },
    { type: 'image', image_id: 'image-resource-id' },
  ],
}];

test('builds ordered Agent v3 text and image messages', () => {
  const input = buildAgentInputMessages(messages);
  const imageAt = input.findIndex(item => item.type === 'image');

  assert.ok(imageAt > 0);
  assert.equal(input[imageAt].image_id, 'image-resource-id');
  assert.match(input[imageAt - 1].text_content, /What is shown/);
});

test('places multimodal messages in user_input', () => {
  const body = buildAgentBody(messages, 'kimi-k2.7-code', 'user', 'device', 1);

  assert.equal(body.model_name, 'kimi-k2.7-code');
  assert.ok(body.user_input.messages.some(item =>
    item.type === 'image' && item.image_id === 'image-resource-id'
  ));
});
