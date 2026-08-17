const crypto = require('crypto');

const MAX_IMAGE_COUNT = 5;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MIN_IMAGE_DIMENSION = 14;
const MAX_IMAGE_DIMENSION = 8192;
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function invalidImage(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function decodeBase64(data) {
  if (typeof data !== 'string' || !data.trim()) {
    throw invalidImage('Image base64 data is required');
  }

  const normalized = data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw invalidImage('Invalid image base64 data');
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer.length) throw invalidImage('Image data is empty');
  return buffer;
}

function normalizeMimeType(mediaType) {
  const normalized = String(mediaType || '').toLowerCase();
  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    throw invalidImage(
      'Unsupported image type. Use JPEG, PNG, GIF, or WebP'
    );
  }
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function expectedImageType(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg';
  return mediaType.slice('image/'.length);
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function readJpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;

  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] !== 0xff) offset++;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;

    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    if (offset + 2 > buffer.length) break;

    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) break;
    if (startOfFrame.has(marker)) {
      if (length < 7) break;
      return {
        type: 'jpg',
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += length;
  }
  return null;
}

function detectImageSize(buffer) {
  if (
    buffer.length >= 24
    && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    && buffer.subarray(12, 16).toString('ascii') === 'IHDR'
  ) {
    return {
      type: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  if (
    buffer.length >= 10
    && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
  ) {
    return {
      type: 'gif',
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  const jpeg = readJpegSize(buffer);
  if (jpeg) return jpeg;

  if (
    buffer.length >= 30
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    const chunk = buffer.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8X') {
      return {
        type: 'webp',
        width: readUInt24LE(buffer, 24) + 1,
        height: readUInt24LE(buffer, 27) + 1,
      };
    }
    if (
      chunk === 'VP8 '
      && buffer.length >= 30
      && buffer[23] === 0x9d
      && buffer[24] === 0x01
      && buffer[25] === 0x2a
    ) {
      return {
        type: 'webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      return {
        type: 'webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
  }

  return null;
}

function validateImage(buffer, mediaType) {
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw invalidImage('Each image must be 3 MB or smaller after base64 decoding');
  }

  const dimensions = detectImageSize(buffer);

  const { width, height, type } = dimensions || {};
  if (!width || !height) throw invalidImage('Image dimensions could not be detected');
  if (type !== expectedImageType(mediaType)) {
    throw invalidImage('Image MIME type does not match its binary content');
  }
  if (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION) {
    throw invalidImage(
      `Image dimensions must be at least ${MIN_IMAGE_DIMENSION}x${MIN_IMAGE_DIMENSION}`
    );
  }
  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw invalidImage(
      `Image dimensions must not exceed ${MAX_IMAGE_DIMENSION}x${MAX_IMAGE_DIMENSION}`
    );
  }

  return {
    id: crypto.randomUUID(),
    buffer,
    mediaType,
    width,
    height,
  };
}

function parseAnthropicImage(block) {
  const source = block && block.source;
  if (!source || source.type !== 'base64') {
    throw invalidImage('Anthropic images must use a base64 source');
  }

  const mediaType = normalizeMimeType(source.media_type);
  return validateImage(decodeBase64(source.data), mediaType);
}

function parseOpenAIImage(block) {
  const imageUrl = typeof block?.image_url === 'string'
    ? block.image_url
    : block?.image_url?.url;

  if (typeof imageUrl !== 'string' || !imageUrl) {
    throw invalidImage('OpenAI image_url.url is required');
  }
  if (/^https?:\/\//i.test(imageUrl)) {
    throw invalidImage('Remote image URLs are not supported; use a data URL');
  }

  const match = imageUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) {
    throw invalidImage('OpenAI images must use a base64 data URL');
  }

  const mediaType = normalizeMimeType(match[1]);
  return validateImage(decodeBase64(match[2]), mediaType);
}

function crc32Hex(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

module.exports = {
  ALLOWED_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  MAX_IMAGE_DIMENSION,
  MIN_IMAGE_DIMENSION,
  crc32Hex,
  detectImageSize,
  parseAnthropicImage,
  parseOpenAIImage,
  validateImage,
};
