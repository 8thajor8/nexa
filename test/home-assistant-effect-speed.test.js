import assert from 'node:assert/strict';
import test from 'node:test';
import { createHomeAssistantEffectSpeedClient } from '../src/integrations/home-assistant/effect-speed.js';

const environment = { NEXA_HOME_ASSISTANT_URL: 'http://ha.test:8123', NEXA_HOME_ASSISTANT_TOKEN: 'synthetic-only' };
const lightId = 'light.bedroom';
const speedId = 'number.bedroom_effect_speed';
const registry = {
  [lightId]: { entity_id: lightId, platform: 'wiz', device_id: 'device-bedroom' },
  [speedId]: { entity_id: speedId, platform: 'wiz', translation_key: 'effect_speed', device_id: 'device-bedroom', disabled_by: null },
  'number.other_integration': { entity_id: 'number.other_integration', platform: 'mqtt', translation_key: 'effect_speed', device_id: 'device-bedroom', disabled_by: null },
  'number.wiz_other_control': { entity_id: 'number.wiz_other_control', platform: 'wiz', translation_key: 'effect_mode', device_id: 'device-bedroom', disabled_by: null },
  'number.no_device': { entity_id: 'number.no_device', platform: 'wiz', translation_key: 'effect_speed', device_id: null, disabled_by: null },
  'number.different_device': { entity_id: 'number.different_device', platform: 'wiz', translation_key: 'effect_speed', device_id: 'another-device', disabled_by: null },
  'number.disabled': { entity_id: 'number.disabled', platform: 'wiz', translation_key: 'effect_speed', device_id: 'device-bedroom', disabled_by: 'user' },
};
const state = (entityId, value, attributes = {}) => ({ entity_id: entityId, state: String(value), attributes });

function fixture({ initial = 40, min = 10, max = 100, step = 5, updateOnSet = true, updateOnWait = true,
  registryEntries = registry, associated = speedId, stateAttributes = {}, speedExists = true,
  socketMode = 'normal', timeoutMs = 5_000, extraNumberStates = [], authorizedLightsProviderOverride } = {}) {
  let speedState = state(speedId, initial, { min, max, step, friendly_name: 'Effect speed', ...stateAttributes });
  const lightState = state(lightId, 'on', {});
  const states = [lightState, speedState, ...extraNumberStates,
    state('number.other_integration', 10), state('number.wiz_other_control', 1),
    state('number.no_device', 10), state('number.different_device', 10), state('number.disabled', 10)];
  const serviceCalls = [];
  const reads = [];
  const waits = [];
  const authorizedLightsProvider = authorizedLightsProviderOverride
    ?? (() => ({ ok: true, authorizedLights: [{ entityId: lightId, effectSpeedEntityId: associated }] }));
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/api/states' && options.method !== 'POST') return response(states);
    if (parsed.pathname.startsWith('/api/states/')) {
      const id = decodeURIComponent(parsed.pathname.slice('/api/states/'.length));
      reads.push(id);
      return response(id === speedId && speedExists ? speedState : states.find(item => item.entity_id === id && id !== speedId) ?? null,
        id === speedId ? (speedExists ? 200 : 404) : states.some(item => item.entity_id === id) ? 200 : 404);
    }
    if (parsed.pathname === '/api/services/number/set_value' && options.method === 'POST') {
      serviceCalls.push(JSON.parse(options.body));
      if (updateOnSet) speedState = { ...speedState, state: String(serviceCalls.at(-1).value) };
      return response({ context: {} });
    }
    throw new Error(`Unexpected synthetic request ${options.method ?? 'GET'} ${parsed.pathname}`);
  };
  class MockWebSocket {
    listeners = new Map();
    constructor(url) { assert.equal(url, 'ws://ha.test:8123/api/websocket'); queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'auth_required' }) })); }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    emit(name, event) { this.listeners.get(name)?.(event); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type === 'auth') {
        assert.equal(message.access_token, 'synthetic-only');
        if (socketMode === 'auth_invalid') queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'auth_invalid' }) }));
        else if (socketMode !== 'silent_auth') queueMicrotask(() => this.emit('message', { data: JSON.stringify({ type: 'auth_ok' }) }));
        return;
      }
      assert.equal(message.type, 'config/entity_registry/get_entries');
      assert.equal(Number.isInteger(message.id), true);
      assert.deepEqual(message.entity_ids, [...new Set(message.entity_ids)]);
      if (socketMode === 'registry_error') {
        queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, type: 'result', success: false,
          error: { code: 'unauthorized', message: 'synthetic internal details' } }) }));
        return;
      }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: message.id, type: 'result', success: true,
        result: Object.fromEntries(message.entity_ids.map(id => [id, registryEntries[id] ?? null])) }) }));
    }
    close() {}
  }
  const client = createHomeAssistantEffectSpeedClient({ environment, fetchImpl, WebSocketImpl: MockWebSocket, timeoutMs,
    authorizedLightsProvider, waitImpl: async ms => { waits.push(ms); if (updateOnWait) speedState = { ...speedState, state: '75' }; } });
  return { client, serviceCalls, reads, waits, getSpeedState: () => speedState };
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

test('discovers only a currently available WiZ effect-speed entity tied to the authorized light device', async () => {
  const { client } = fixture();
  assert.deepEqual(await client.discoverEffectSpeedCandidates(lightId), [{ entityId: speedId,
    name: 'Effect speed', available: true, sameDeviceVerified: true }]);
});

test('fails closed on registry authorization errors and WebSocket timeout', async () => {
  const unauthorized = fixture({ socketMode: 'auth_invalid' });
  await assert.rejects(unauthorized.client.discoverEffectSpeedCandidates(lightId), error => error.code === 'home_assistant_unauthorized');
  const forbidden = fixture({ socketMode: 'registry_error' });
  await assert.rejects(forbidden.client.discoverEffectSpeedCandidates(lightId), error => error.code === 'home_assistant_forbidden');
  const timeout = fixture({ socketMode: 'silent_auth', timeoutMs: 100 });
  await assert.rejects(timeout.client.discoverEffectSpeedCandidates(lightId), error => error.code === 'home_assistant_timeout');
});

test('returns multiple valid candidates without choosing one implicitly', async () => {
  const secondId = 'number.bedroom_effect_speed_secondary';
  const entries = { ...registry, [secondId]: { entity_id: secondId, platform: 'wiz', translation_key: 'effect_speed',
    device_id: 'device-bedroom', disabled_by: null } };
  const base = fixture({ registryEntries: entries, extraNumberStates: [state(secondId, 30, { min: 10, max: 100, step: 5 })] });
  const candidates = await base.client.discoverEffectSpeedCandidates(lightId);
  assert.deepEqual(candidates.map(candidate => candidate.entityId), [speedId, secondId]);
});

test('reads actual bounds, step, value and availability instead of assuming a speed range', async () => {
  const { client } = fixture({ initial: 37, min: 7, max: 97, step: 3 });
  assert.deepEqual(await client.getEffectSpeed(lightId), { lightEntityId: lightId, linked: true, available: true,
    stale: false, value: 37, min: 7, max: 97, step: 3, entityName: 'Effect speed', error: null });
  const unavailable = fixture({ stateAttributes: {}, initial: 'unavailable' });
  assert.equal((await unavailable.client.getEffectSpeed(lightId)).available, false);
});

test('rejects a stale device association before writing', async () => {
  const entries = { ...registry, [speedId]: { ...registry[speedId], device_id: 'reassigned-device' } };
  const { client, serviceCalls } = fixture({ registryEntries: entries });
  await assert.rejects(client.setEffectSpeed({ lightEntityId: lightId, value: 45 }), error => error.code === 'home_assistant_speed_link_stale');
  assert.deepEqual(serviceCalls, []);
});

test('rechecks the persistent light authorization immediately before the service write', async () => {
  let authorizationReads = 0;
  const { client, serviceCalls } = fixture({ authorizedLightsProviderOverride: () => {
    authorizationReads += 1;
    return { ok: true, authorizedLights: authorizationReads < 3 ? [{ entityId: lightId, effectSpeedEntityId: speedId }] : [] };
  } });
  await assert.rejects(client.setEffectSpeed({ lightEntityId: lightId, value: 45 }), error => error.code === 'home_assistant_light_not_authorized');
  assert.deepEqual(serviceCalls, []);
});

test('marks a removed number entity stale so the UI can request a new explicit link', async () => {
  const { client, serviceCalls } = fixture({ speedExists: false });
  const current = await client.getEffectSpeed(lightId);
  assert.equal(current.stale, true);
  assert.equal(current.available, false);
  await assert.rejects(client.setEffectSpeed({ lightEntityId: lightId, value: 45 }), error => error.code === 'home_assistant_speed_link_stale');
  assert.deepEqual(serviceCalls, []);
});

test('validates live range and step, then sends one fixed number.set_value service call', async () => {
  const { client, serviceCalls, waits } = fixture({ min: 10, max: 100, step: 5 });
  await assert.rejects(client.setEffectSpeed({ lightEntityId: lightId, value: 46 }), error => error.code === 'home_assistant_speed_value_invalid');
  await assert.rejects(client.setEffectSpeed({ lightEntityId: lightId, value: 105 }), error => error.code === 'home_assistant_speed_value_invalid');
  assert.deepEqual(serviceCalls, []);
  const result = await client.setEffectSpeed({ lightEntityId: lightId, value: 45 });
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(serviceCalls, [{ entity_id: speedId, value: 45 }]);
  assert.deepEqual(waits, []);
});

test('confirms on the first adaptive retry without resending the action', async () => {
  const { client, serviceCalls, waits } = fixture({ updateOnSet: false });
  const result = await client.setEffectSpeed({ lightEntityId: lightId, value: 75 });
  assert.equal(result.outcome, 'confirmed');
  assert.deepEqual(serviceCalls, [{ entity_id: speedId, value: 75 }]);
  assert.deepEqual(waits, [100]);
});

test('returns accepted_not_confirmed when the live value does not change', async () => {
  const { client, serviceCalls, waits } = fixture({ initial: 40, updateOnSet: false, updateOnWait: false,
    stateAttributes: { min: 0, max: 100, step: 1 } });
  const result = await client.setEffectSpeed({ lightEntityId: lightId, value: 75 });
  assert.equal(result.outcome, 'accepted_not_confirmed');
  assert.deepEqual(serviceCalls, [{ entity_id: speedId, value: 75 }]);
  assert.equal(waits.reduce((sum, delay) => sum + delay, 0), 3000);
  assert.ok(waits.every(delay => delay > 0 && delay < 3000));
});

test('does not allow an arbitrary light or number entity to be controlled', async () => {
  const { client, serviceCalls } = fixture();
  await assert.rejects(client.setEffectSpeed({ lightEntityId: 'light.unknown', value: 45 }), error => error.code === 'home_assistant_light_not_authorized');
  assert.equal(await client.associationIsCurrent({ entityId: lightId }, 'number.other_integration'), false);
  assert.equal(await client.associationIsCurrent({ entityId: lightId }, 'number.arbitrary'), false);
  assert.deepEqual(serviceCalls, []);
});
