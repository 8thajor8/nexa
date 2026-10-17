import assert from 'node:assert/strict';
import test from 'node:test';
import { createHomeAssistantDiscoveryClient } from '../src/integrations/home-assistant/client.js';

const response = data => ({ ok: true, status: 200, json: async () => data });
const ENV = Object.freeze({ NEXA_HOME_ASSISTANT_URL: 'http://ha.example:8123', NEXA_HOME_ASSISTANT_TOKEN: 'synthetic-token' });

test('read-only discovery filters non-light entities and returns only safe light fields', async () => {
  const calls = [];
  const client = createHomeAssistantDiscoveryClient({ environment: ENV, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return response([
      { entity_id: 'sensor.temperature', state: '21', attributes: { friendly_name: 'Temperature' } },
      { entity_id: 'light.office', state: 'on', attributes: { friendly_name: 'Office', brightness: 120,
        supported_color_modes: ['rgb'], rgb_color: [1, 2, 3], internal: 'must_not_escape' } },
      { entity_id: 'light.broken', state: 'invalid', attributes: { friendly_name: 'Broken' } },
      { entity_id: 'switch.kitchen', state: 'on', attributes: { friendly_name: 'Switch' } },
    ]);
  } });
  assert.deepEqual(await client.discoverLights(), [{ entityId: 'light.office', name: 'Office', state: 'on', available: true,
    capabilities: { brightness: true, color: true } }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://ha.example:8123/api/states');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(Object.hasOwn(calls[0].options, 'body'), false);
});

test('discovery rejects missing credentials or malformed HA responses without further requests', async () => {
  let calls = 0;
  const missing = createHomeAssistantDiscoveryClient({ environment: {}, fetchImpl: async () => { calls++; return response([]); } });
  await assert.rejects(missing.discoverLights(), error => error.code === 'home_assistant_not_configured');
  const malformed = createHomeAssistantDiscoveryClient({ environment: ENV, fetchImpl: async () => response({ lights: [] }) });
  await assert.rejects(malformed.discoverLights(), error => error.code === 'home_assistant_response_invalid');
  assert.equal(calls, 0);
});
