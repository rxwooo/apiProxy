const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99
};

const SENSITIVE_KEY_PATTERN =
  /authorization|api[-_]?key|token|secret|password|credential|cookie|body|prompt|messages|content/i;

function isSensitiveKey(key) {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return SENSITIVE_KEY_PATTERN.test(key) || normalized === 'relayproxy' || normalized.endsWith('proxyurl');
}

export function redact(value) {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== 'object') return value;

  const redacted = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      redacted[key] = '[redacted]';
    } else {
      redacted[key] = redact(child);
    }
  }
  return redacted;
}

export function createLogger({ level = 'info', name = 'api-proxy', stream = process.stderr } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(levelName, event, metadata = {}) {
    if ((LEVELS[levelName] ?? LEVELS.info) < threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level: levelName,
      name,
      event,
      ...redact(metadata)
    };
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (event, metadata) => write('debug', event, metadata),
    info: (event, metadata) => write('info', event, metadata),
    warn: (event, metadata) => write('warn', event, metadata),
    error: (event, metadata) => write('error', event, metadata)
  };
}
