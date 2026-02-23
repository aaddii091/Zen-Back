const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

const getChatKey = () => {
  const raw = String(process.env.CHAT_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;

  // Prefer 64-char hex key.
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // Fallback: base64 encoded 32-byte key.
  try {
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
  } catch {
    return null;
  }

  return null;
};

exports.isChatEncryptionReady = () => Boolean(getChatKey());

exports.encryptChatText = (plainText) => {
  const key = getChatKey();
  if (!key) {
    throw new Error('CHAT_ENCRYPTION_KEY is missing or invalid.');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText || ''), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    textCipher: encrypted.toString('base64'),
    textIv: iv.toString('base64'),
    textAuthTag: authTag.toString('base64'),
    keyVersion: 1,
  };
};

exports.decryptChatText = (payload = {}) => {
  const key = getChatKey();
  if (!key) {
    throw new Error('CHAT_ENCRYPTION_KEY is missing or invalid.');
  }

  const iv = Buffer.from(String(payload.textIv || ''), 'base64');
  const authTag = Buffer.from(String(payload.textAuthTag || ''), 'base64');
  const encrypted = Buffer.from(String(payload.textCipher || ''), 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString('utf8');
};
