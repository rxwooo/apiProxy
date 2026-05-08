import { StringDecoder } from 'node:string_decoder';

export function applyModelIdMap(body, modelIdMap = {}) {
  if (!body?.length || Object.keys(modelIdMap).length === 0) {
    return { body, mapped: false };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    return { body, mapped: false };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { body, mapped: false };
  }

  const originalModel = payload.model;
  if (typeof originalModel !== 'string' || !Object.hasOwn(modelIdMap, originalModel)) {
    return { body, mapped: false, originalModel };
  }

  const mappedModel = modelIdMap[originalModel];
  const mappedPayload = {
    ...payload,
    model: mappedModel
  };

  return {
    body: Buffer.from(JSON.stringify(mappedPayload)),
    mapped: true,
    originalModel,
    mappedModel
  };
}

export function applyResponseModelIdMap(body, requestMapping = {}) {
  if (!body?.length || !requestMapping.mapped) {
    return { body, mapped: false };
  }

  const result = mapJsonModel(Buffer.from(body).toString('utf8'), requestMapping);
  if (!result.mapped) return { body, mapped: false };

  return {
    body: Buffer.from(result.text),
    mapped: true,
    originalModel: requestMapping.mappedModel,
    mappedModel: requestMapping.originalModel
  };
}

export function createSseResponseModelMapper(requestMapping = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';

  return {
    push(chunk) {
      pending += decoder.write(Buffer.from(chunk));
      return drainCompleteLines();
    },
    flush() {
      pending += decoder.end();
      const output = drainCompleteLines();
      if (pending) {
        output.push(Buffer.from(mapSseLine(pending, requestMapping)));
        pending = '';
      }
      return output;
    }
  };

  function drainCompleteLines() {
    const output = [];
    for (;;) {
      const match = pending.match(/\r\n|\n|\r/);
      if (!match) return output;

      const line = pending.slice(0, match.index + match[0].length);
      pending = pending.slice(match.index + match[0].length);
      output.push(Buffer.from(mapSseLine(line, requestMapping)));
    }
  }
}

function mapSseLine(line, requestMapping) {
  if (!requestMapping.mapped) return line;

  const eolMatch = line.match(/(\r\n|\n|\r)$/);
  const eol = eolMatch?.[0] ?? '';
  const content = eol ? line.slice(0, -eol.length) : line;
  if (!content.startsWith('data:')) return line;

  const hasSpace = content.startsWith('data: ');
  const prefix = hasSpace ? 'data: ' : 'data:';
  const data = content.slice(prefix.length);
  if (!data || data.trim() === '[DONE]') return line;

  const result = mapJsonModel(data, requestMapping);
  return result.mapped ? `${prefix}${result.text}${eol}` : line;
}

function mapJsonModel(jsonText, requestMapping) {
  let payload;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return { text: jsonText, mapped: false };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { text: jsonText, mapped: false };
  }

  if (payload.model !== requestMapping.mappedModel) {
    return { text: jsonText, mapped: false };
  }

  return {
    text: JSON.stringify({
      ...payload,
      model: requestMapping.originalModel
    }),
    mapped: true
  };
}
