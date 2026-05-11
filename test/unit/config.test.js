import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPSTREAM_ROUTING_AUTO,
  UPSTREAM_ROUTING_SINGLE,
  UPSTREAM_PROVIDER_ANTHROPIC,
  UPSTREAM_PROVIDER_OPENAI,
  createRemoteConfig,
  parseUpstreamProvider,
  parseUpstreamRouting
} from '../../src/shared/config.js';

test('parseUpstreamProvider accepts supported providers and defaults to openai', () => {
  assert.equal(parseUpstreamProvider(), UPSTREAM_PROVIDER_OPENAI);
  assert.equal(parseUpstreamProvider('OPENAI'), UPSTREAM_PROVIDER_OPENAI);
  assert.equal(parseUpstreamProvider(' anthropic '), UPSTREAM_PROVIDER_ANTHROPIC);
  assert.throws(() => parseUpstreamProvider('other'), /UPSTREAM_PROVIDER must be one of/);
});

test('parseUpstreamRouting accepts supported routing modes and defaults to single', () => {
  assert.equal(parseUpstreamRouting(), UPSTREAM_ROUTING_SINGLE);
  assert.equal(parseUpstreamRouting('AUTO'), UPSTREAM_ROUTING_AUTO);
  assert.equal(parseUpstreamRouting(' single '), UPSTREAM_ROUTING_SINGLE);
  assert.throws(() => parseUpstreamRouting('other'), /UPSTREAM_ROUTING must be one of/);
});

test('createRemoteConfig defaults to OpenAI provider settings', () => {
  const config = createRemoteConfig({ envFile: 'missing.env', env: {} });

  assert.equal(config.upstreamRouting, UPSTREAM_ROUTING_SINGLE);
  assert.equal(config.upstreamProvider, UPSTREAM_PROVIDER_OPENAI);
  assert.equal(config.upstreamBaseUrl, 'https://api.openai.com');
  assert.equal(config.upstreamAuthScheme, 'Bearer');
  assert.equal(config.upstreamProviders.openai.baseUrl, 'https://api.openai.com');
});

test('createRemoteConfig loads Anthropic provider settings', () => {
  const config = createRemoteConfig({
    envFile: 'missing.env',
    env: {
      UPSTREAM_PROVIDER: 'anthropic',
      UPSTREAM_API_KEY: 'anthropic-key',
      ANTHROPIC_VERSION: '2023-06-01',
      ANTHROPIC_BETA: 'tools-2024-04-04'
    }
  });

  assert.equal(config.upstreamProvider, UPSTREAM_PROVIDER_ANTHROPIC);
  assert.equal(config.upstreamBaseUrl, 'https://api.anthropic.com');
  assert.equal(config.upstreamApiKey, 'anthropic-key');
  assert.equal(config.anthropicVersion, '2023-06-01');
  assert.equal(config.anthropicBeta, 'tools-2024-04-04');
  assert.equal(config.upstreamProviders.anthropic.apiKey, 'anthropic-key');
});

test('createRemoteConfig loads automatic routing provider settings', () => {
  const config = createRemoteConfig({
    envFile: 'missing.env',
    env: {
      UPSTREAM_ROUTING: 'auto',
      OPENAI_BASE_URL: 'https://openai.example.com',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_AUTH_SCHEME: 'Token',
      ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_VERSION: '2023-06-01'
    }
  });

  assert.equal(config.upstreamRouting, UPSTREAM_ROUTING_AUTO);
  assert.equal(config.upstreamProviders.openai.baseUrl, 'https://openai.example.com');
  assert.equal(config.upstreamProviders.openai.apiKey, 'openai-key');
  assert.equal(config.upstreamProviders.openai.authScheme, 'Token');
  assert.equal(config.upstreamProviders.anthropic.baseUrl, 'https://anthropic.example.com');
  assert.equal(config.upstreamProviders.anthropic.apiKey, 'anthropic-key');
  assert.equal(config.upstreamProviders.anthropic.anthropicVersion, '2023-06-01');
});

test('createRemoteConfig validates Anthropic provider configuration', () => {
  assert.throws(
    () =>
      createRemoteConfig({
        envFile: 'missing.env',
        env: { UPSTREAM_PROVIDER: 'anthropic' }
      }),
    /ANTHROPIC_VERSION is required/
  );

  assert.throws(
    () =>
      createRemoteConfig({
        envFile: 'missing.env',
        env: { UPSTREAM_PROVIDER: 'unsupported' }
      }),
    /UPSTREAM_PROVIDER must be one of/
  );

  assert.throws(
    () =>
      createRemoteConfig({
        envFile: 'missing.env',
        env: { UPSTREAM_ROUTING: 'auto' }
      }),
    /ANTHROPIC_VERSION is required/
  );
});

test('createRemoteConfig keeps production upstream API key validation', () => {
  assert.throws(
    () =>
      createRemoteConfig({
        envFile: 'missing.env',
        env: {
          NODE_ENV: 'production',
          RELAY_TOKEN: 'relay-token',
          UPSTREAM_PROVIDER: 'anthropic',
          ANTHROPIC_VERSION: '2023-06-01'
        }
      }),
    /UPSTREAM_API_KEY is required in production/
  );

  assert.throws(
    () =>
      createRemoteConfig({
        envFile: 'missing.env',
        env: {
          NODE_ENV: 'production',
          RELAY_TOKEN: 'relay-token',
          UPSTREAM_ROUTING: 'auto',
          OPENAI_API_KEY: 'openai-key',
          ANTHROPIC_VERSION: '2023-06-01'
        }
      }),
    /ANTHROPIC_API_KEY is required in production/
  );
});
