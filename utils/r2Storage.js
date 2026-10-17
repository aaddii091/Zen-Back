// Cloudflare R2 object storage, for photos of handwritten counsellor notes.
//
// R2 speaks the S3 API, so this is the standard S3 client pointed at an R2
// endpoint. Deliberately NOT the `data: Buffer` pattern ticketModel.js and
// therapistProfileModel.js use — embedding images in Mongo documents bloats
// every query that touches them and does not scale past a handful of files.
//
// Uploads and downloads are presigned and go browser -> R2 directly. The image
// never transits the API, which matters because the whole backend runs as one
// Vercel function with a 60s cap (vercel.json).
//
// The bucket must be PRIVATE. Reads only ever happen through a short-lived
// presigned GET issued after the same access check as the note itself.

const crypto = require('crypto');
const { S3Client, DeleteObjectCommand, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — a phone photo of a page
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/pdf',
]);

let cachedClient = null;

const config = () => ({
  accountId: process.env.R2_ACCOUNT_ID || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || '',
});

// Mirrors isChatEncryptionReady: a feature whose dependency is unconfigured
// should report that clearly rather than throwing deep inside a request.
const isStorageReady = () => {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config();
  return Boolean(accountId && accessKeyId && secretAccessKey && bucket);
};

const client = () => {
  if (cachedClient) return cachedClient;
  const { accountId, accessKeyId, secretAccessKey } = config();

  cachedClient = new S3Client({
    region: 'auto', // R2 is region-less; 'auto' is what Cloudflare documents
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return cachedClient;
};

// notes/{organizationId}/{studentId}/{noteId}/{uuid}{ext}
//
// Organization-first so a school's objects sit under one prefix — that is what
// makes "delete everything for this school" a prefix operation rather than a
// full-bucket scan, which a DPDP erasure request will eventually need.
const buildObjectKey = ({ organizationId, studentId, noteId, contentType }) => {
  const extension =
    {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/heic': '.heic',
      'application/pdf': '.pdf',
    }[contentType] || '';

  return `notes/${organizationId}/${studentId}/${noteId}/${crypto.randomUUID()}${extension}`;
};

const presignUpload = async ({ key, contentType, contentLength }) => {
  const { bucket } = config();

  // The signature covers content-type and length, so a client cannot sign a
  // 2 MB JPEG and then upload a 2 GB video or an executable.
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  return getSignedUrl(client(), command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
};

const presignDownload = async ({ key }) => {
  const { bucket } = config();
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client(), command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
};

// Confirms the browser actually completed the upload before the note records the
// attachment, so a failed PUT does not leave a note pointing at nothing.
const objectExists = async ({ key }) => {
  const { bucket } = config();
  try {
    await client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
};

const deleteObject = async ({ key }) => {
  const { bucket } = config();
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
};

module.exports = {
  isStorageReady,
  buildObjectKey,
  presignUpload,
  presignDownload,
  objectExists,
  deleteObject,
  MAX_UPLOAD_BYTES,
  ALLOWED_CONTENT_TYPES,
  UPLOAD_URL_TTL_SECONDS,
  DOWNLOAD_URL_TTL_SECONDS,
};
