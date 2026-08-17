const assert = require('node:assert/strict');
const test = require('node:test');
const {
  hasImageInput,
  isMultimodalConfig,
} = require('../src/trae-client');

test('reads multimodal capability from the Trae catalog config', () => {
  assert.equal(
    isMultimodalConfig({ display_config: { multimodal: true } }),
    true
  );
  assert.equal(
    isMultimodalConfig({ display_config: { multimodal: false } }),
    false
  );
});

test('detects normalized image input', () => {
  assert.equal(hasImageInput([{
    role: 'user',
    content: [{ type: 'image', image: {} }],
  }]), true);
  assert.equal(hasImageInput([{ role: 'user', content: 'text' }]), false);
});
