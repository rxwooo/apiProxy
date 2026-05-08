export const PROTOCOL_VERSION = 1;

export const MESSAGE_TYPES = Object.freeze({
  REQUEST_START: 'request.start',
  REQUEST_CHUNK: 'request.chunk',
  REQUEST_END: 'request.end',
  REQUEST_CANCEL: 'request.cancel',
  RESPONSE_START: 'response.start',
  RESPONSE_CHUNK: 'response.chunk',
  RESPONSE_END: 'response.end',
  ERROR: 'error',
  ACK: 'ack',
  PING: 'ping',
  PONG: 'pong'
});

const BINARY_CHUNK_TYPES = new Set([
  MESSAGE_TYPES.REQUEST_CHUNK,
  MESSAGE_TYPES.RESPONSE_CHUNK
]);

export class ProtocolError extends Error {
  constructor(message, { code = 'PROTOCOL_ERROR', status = 400 } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = status;
  }
}

export function encodeJsonMessage(message) {
  return JSON.stringify({ version: PROTOCOL_VERSION, ...message });
}

export function decodeJsonMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new ProtocolError('Invalid JSON relay message', { code: 'INVALID_JSON' });
  }
  if (message.version !== PROTOCOL_VERSION) {
    throw new ProtocolError('Unsupported relay protocol version', {
      code: 'UNSUPPORTED_VERSION'
    });
  }
  if (!message.type) {
    throw new ProtocolError('Relay message is missing type', { code: 'MISSING_TYPE' });
  }
  return message;
}

export function encodeChunkMessage({ type, id, seq }, payload) {
  if (!BINARY_CHUNK_TYPES.has(type)) {
    throw new ProtocolError('Invalid binary chunk message type', { code: 'INVALID_CHUNK_TYPE' });
  }
  if (!id) throw new ProtocolError('Chunk message is missing request id', { code: 'MISSING_ID' });
  if (!Number.isInteger(seq) || seq < 0) {
    throw new ProtocolError('Chunk sequence must be a non-negative integer', {
      code: 'INVALID_SEQUENCE'
    });
  }

  const bytes = Buffer.from(payload);
  const header = Buffer.from(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      type,
      id,
      seq,
      payloadBytes: bytes.length
    })
  );
  const frame = Buffer.allocUnsafe(4 + header.length + bytes.length);
  frame.writeUInt32BE(header.length, 0);
  header.copy(frame, 4);
  bytes.copy(frame, 4 + header.length);
  return frame;
}

export function decodeChunkMessage(data) {
  const frame = Buffer.from(data);
  if (frame.length < 4) {
    throw new ProtocolError('Binary relay frame is too short', { code: 'INVALID_FRAME' });
  }

  const headerLength = frame.readUInt32BE(0);
  if (headerLength <= 0 || headerLength > frame.length - 4) {
    throw new ProtocolError('Binary relay frame has invalid header length', {
      code: 'INVALID_FRAME_HEADER'
    });
  }

  let header;
  try {
    header = JSON.parse(frame.subarray(4, 4 + headerLength).toString('utf8'));
  } catch {
    throw new ProtocolError('Binary relay frame header is not valid JSON', {
      code: 'INVALID_FRAME_HEADER'
    });
  }

  if (header.version !== PROTOCOL_VERSION) {
    throw new ProtocolError('Unsupported binary frame protocol version', {
      code: 'UNSUPPORTED_VERSION'
    });
  }
  if (!BINARY_CHUNK_TYPES.has(header.type)) {
    throw new ProtocolError('Binary relay frame has invalid message type', {
      code: 'INVALID_CHUNK_TYPE'
    });
  }

  const payload = frame.subarray(4 + headerLength);
  if (payload.length !== header.payloadBytes) {
    throw new ProtocolError('Binary relay frame payload length mismatch', {
      code: 'INVALID_FRAME_LENGTH'
    });
  }

  return { header, payload };
}

export function errorMessage({ id, code, message, status = 502 }) {
  return {
    type: MESSAGE_TYPES.ERROR,
    id,
    code,
    message,
    status
  };
}
