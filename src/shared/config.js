import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_CHUNK_SIZE, validateChunkSize } from './chunking.js';

const DEFAULT_MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

export function parseDotEnv(content) {
  const parsed = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (!key) continue;

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }
  return parsed;
}

export function loadConfigEnv({ cwd = process.cwd(), env = process.env, envFile = '.env' } = {}) {
  const merged = { ...env };
  const filePath = resolve(cwd, envFile);
  if (existsSync(filePath)) {
    const parsed = parseDotEnv(readFileSync(filePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (merged[key] === undefined) merged[key] = value;
    }
  }
  return merged;
}

function numberValue(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }
  return value;
}

function stringValue(env, key, fallback = '') {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function parseModelIdMap(raw = '') {
  if (!raw) return {};

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('MODEL_ID_MAP must be valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('MODEL_ID_MAP must be a JSON object');
  }

  const modelIdMap = {};
  for (const [alias, modelId] of Object.entries(parsed)) {
    if (!alias || typeof modelId !== 'string' || !modelId) {
      throw new Error('MODEL_ID_MAP keys and values must be non-empty strings');
    }
    modelIdMap[alias] = modelId;
  }
  return modelIdMap;
}

function commonConfig(env) {
  return {
    chunkSize: validateChunkSize(numberValue(env, 'CHUNK_SIZE', DEFAULT_CHUNK_SIZE)),
    requestTimeoutMs: numberValue(env, 'REQUEST_TIMEOUT_MS', 120_000),
    connectTimeoutMs: numberValue(env, 'RELAY_CONNECT_TIMEOUT_MS', 5_000),
    heartbeatIntervalMs: numberValue(env, 'HEARTBEAT_INTERVAL_MS', 30_000),
    maxRequestBytes: numberValue(env, 'MAX_REQUEST_BYTES', DEFAULT_MAX_REQUEST_BYTES),
    maxResponseBytes: numberValue(env, 'MAX_RESPONSE_BYTES', DEFAULT_MAX_RESPONSE_BYTES),
    maxConcurrentRequests: numberValue(env, 'MAX_CONCURRENT_REQUESTS', 32),
    logLevel: stringValue(env, 'LOG_LEVEL', 'info'),
    nodeEnv: stringValue(env, 'NODE_ENV', 'development')
  };
}

function assertPositive(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validateCommon(config) {
  assertPositive('REQUEST_TIMEOUT_MS', config.requestTimeoutMs);
  assertPositive('RELAY_CONNECT_TIMEOUT_MS', config.connectTimeoutMs);
  assertPositive('HEARTBEAT_INTERVAL_MS', config.heartbeatIntervalMs);
  assertPositive('MAX_REQUEST_BYTES', config.maxRequestBytes);
  assertPositive('MAX_RESPONSE_BYTES', config.maxResponseBytes);
  assertPositive('MAX_CONCURRENT_REQUESTS', config.maxConcurrentRequests);
  if (config.maxRequestBytes < config.chunkSize) {
    throw new Error('MAX_REQUEST_BYTES must be >= CHUNK_SIZE');
  }
  if (config.maxResponseBytes < config.chunkSize) {
    throw new Error('MAX_RESPONSE_BYTES must be >= CHUNK_SIZE');
  }
}

export function createLocalConfig(options = {}) {
  const env = loadConfigEnv(options);
  const config = {
    ...commonConfig(env),
    host: stringValue(env, 'LOCAL_HOST', '127.0.0.1'),
    port: numberValue(env, 'LOCAL_PORT', 8787),
    relayUrl: stringValue(env, 'RELAY_URL', 'ws://127.0.0.1:8788/relay'),
    relayToken: stringValue(env, 'RELAY_TOKEN')
  };

  validateCommon(config);
  assertPositive('LOCAL_PORT', config.port);
  new URL(config.relayUrl);

  if (config.nodeEnv === 'production') {
    if (!config.relayToken) throw new Error('RELAY_TOKEN is required in production');
    if (!config.relayUrl.startsWith('wss://')) {
      throw new Error('RELAY_URL must use wss:// in production');
    }
    const loopback = ['127.0.0.1', '::1', 'localhost'];
    if (!loopback.includes(config.host) && env.ALLOW_PUBLIC_LOCAL_PROXY !== 'true') {
      throw new Error('Refusing to expose local proxy outside loopback in production');
    }
  }

  return config;
}

export function createRemoteConfig(options = {}) {
  const env = loadConfigEnv(options);
  const config = {
    ...commonConfig(env),
    host: stringValue(env, 'RELAY_HOST', '0.0.0.0'),
    port: numberValue(env, 'RELAY_PORT', 8788),
    relayPath: stringValue(env, 'RELAY_PATH', '/relay'),
    relayToken: stringValue(env, 'RELAY_TOKEN'),
    upstreamBaseUrl: stringValue(env, 'UPSTREAM_BASE_URL', 'https://api.openai.com'),
    upstreamApiKey: stringValue(env, 'UPSTREAM_API_KEY'),
    upstreamAuthScheme: stringValue(env, 'UPSTREAM_AUTH_SCHEME', 'Bearer'),
    modelIdMap: parseModelIdMap(stringValue(env, 'MODEL_ID_MAP'))
  };

  validateCommon(config);
  assertPositive('RELAY_PORT', config.port);
  if (!config.relayPath.startsWith('/')) throw new Error('RELAY_PATH must start with /');
  new URL(config.upstreamBaseUrl);

  if (config.nodeEnv === 'production') {
    if (!config.relayToken) throw new Error('RELAY_TOKEN is required in production');
    if (!config.upstreamApiKey) throw new Error('UPSTREAM_API_KEY is required in production');
    if (!config.upstreamBaseUrl.startsWith('https://')) {
      throw new Error('UPSTREAM_BASE_URL must use https:// in production');
    }
  }

  return config;
}
