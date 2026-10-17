// Minimal smoke-test harness.
//
// There is no test framework in this project and adding one is out of scope, so
// this is a dependency-free runner: boot the real Express app in-process against a
// throwaway Mongo, drive it over HTTP, assert on the responses.
//
// Start the database first:
//   docker run -d --name zen-test-mongo -p 27018:27017 mongo:7
//
// Then run:
//   npm run smoke
//
// SAFETY: the runner refuses to start unless DATABASE points at a local host, so a
// stray run can never wipe Atlas. See assertLocalDatabase below.

const path = require('path');
const mongoose = require('mongoose');

process.env.DATABASE =
  process.env.DATABASE || 'mongodb://127.0.0.1:27018/zengarden_smoke';
process.env.NODE_ENV = 'test';

require('dotenv').config({ path: path.join(__dirname, '..', '..', 'config.env') });

// dotenv does not overwrite values already present in process.env, so the two
// assignments above win over config.env. Re-assert anyway: a future dotenv version
// flipping that default would otherwise point this runner at production.
process.env.DATABASE =
  process.env.SMOKE_DATABASE || 'mongodb://127.0.0.1:27018/zengarden_smoke';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-test-secret';
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1d';
// 32-byte key so chat encryption is exercised rather than skipped.
process.env.CHAT_ENCRYPTION_KEY =
  process.env.CHAT_ENCRYPTION_KEY || 'a'.repeat(64);

const assertLocalDatabase = () => {
  const uri = String(process.env.DATABASE || '');
  const isLocal =
    uri.includes('127.0.0.1') ||
    uri.includes('localhost') ||
    uri.includes('mongodb://mongo');
  if (!isLocal) {
    throw new Error(
      `Refusing to run smoke tests against a non-local database: ${uri.replace(/\/\/[^@]*@/, '//<redacted>@')}`,
    );
  }
};

/* ------------------------------------------------------------------ state */

let server = null;
let baseUrl = '';

const results = [];
let currentSuite = '';

/* ------------------------------------------------------------- assertions */

const check = (label, condition, detail = '') => {
  results.push({
    suite: currentSuite,
    label,
    passed: Boolean(condition),
    detail: condition ? '' : detail,
  });
};

const checkEqual = (label, actual, expected) =>
  check(
    label,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );

/* ------------------------------------------------------------------- http */

const api = async (method, routePath, { token, body, raw } = {}) => {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body && !raw) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}/api/v1${routePath}`, {
    method,
    headers,
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });

  let payload = null;
  const text = await response.text();
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }

  return { status: response.status, body: payload };
};

/* ----------------------------------------------------------------- boot */

const boot = async () => {
  assertLocalDatabase();

  await mongoose.connect(process.env.DATABASE, {
    serverSelectionTimeoutMS: 5000,
  });
  // Fresh database every run: these suites assert on absolute counts.
  await mongoose.connection.db.dropDatabase();

  const app = require('../../index');
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  return { baseUrl };
};

const shutdown = async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await mongoose.connection.close();
};

/* ---------------------------------------------------------------- report */

const suite = (name) => {
  currentSuite = name;
};

const report = () => {
  const failed = results.filter((r) => !r.passed);
  let lastSuite = '';

  for (const r of results) {
    if (r.suite !== lastSuite) {
      console.log(`\n  ${r.suite}`);
      lastSuite = r.suite;
    }
    const mark = r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    console.log(`    ${mark} ${r.label}`);
    if (!r.passed && r.detail) console.log(`        ${r.detail}`);
  }

  console.log(
    `\n  ${results.length - failed.length}/${results.length} passed${
      failed.length ? `, \x1b[31m${failed.length} failed\x1b[0m` : ''
    }\n`,
  );

  return failed.length === 0;
};

module.exports = {
  boot,
  shutdown,
  api,
  check,
  checkEqual,
  suite,
  report,
  mongoose,
};
