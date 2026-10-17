import assert from 'node:assert/strict';
import test from 'node:test';

import { createHomeAssistantClient } from '../src/integrations/home-assistant/client.js';
import { createHomeAssistantRegistrations, createHomeAssistantToolSelector } from '../src/tools/home-assistant.js';
import { defaultPermissionPolicy } from '../src/tools/permissions.js';
import { executeTool, getToolsForModel } from '../src/tools/index.js';

const ENV = Object.freeze({ NEXA_HOME_ASSISTANT_URL: 'http://127.0.0.1:8123',
    NEXA_HOME_ASSISTANT_TOKEN: 'synthetic-ha-token', NEXA_HOME_ASSISTANT_LIGHTS: 'light.office' });
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const state = (value = 'off', attributes = {}) => ({ entity_id: 'light.office', state: value,
    attributes: { friendly_name: 'Luz de prueba', supported_color_modes: ['onoff', 'brightness', 'rgb'],
        brightness: value === 'on' ? 128 : null, rgb_color: value === 'on' ? [30, 60, 90] : null, ...attributes } });
const clientWith = (fetchImpl, environment = ENV, waitImpl = async () => {}) =>
    createHomeAssistantClient({ environment, fetchImpl, timeoutMs: 1000, waitImpl });
const MULTI_ENV = Object.freeze({ ...ENV, NEXA_HOME_ASSISTANT_LIGHTS: 'light.office,light.kitchen',
    NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([
        { entityId: 'light.office', name: 'Luz de escritorio', area: 'Escritorio', aliases: ['lámpara de trabajo'] },
        { entityId: 'light.kitchen', name: 'Luz de techo', area: 'Cocina', aliases: ['plafón'] },
    ]) });
const stateFor = (entityId, value = 'off', name = entityId, attributes = {}) => ({ entity_id: entityId, state: value,
    attributes: { friendly_name: name, supported_color_modes: ['onoff', 'brightness', 'rgb'],
        brightness: value === 'on' ? 128 : null, rgb_color: value === 'on' ? [30, 60, 90] : null, ...attributes } });

test('missing and invalid configuration fail before any request', async () => {
    let calls = 0;
    await assert.rejects(clientWith(async () => { calls++; return json({}); }, {}).listAuthorizedLights(),
        error => error.code === 'home_assistant_not_configured');
    await assert.rejects(clientWith(async () => json({}), { ...ENV, NEXA_HOME_ASSISTANT_URL: 'file:///tmp' })
        .listAuthorizedLights(), error => error.code === 'home_assistant_configuration_invalid');
    await assert.rejects(clientWith(async () => json({}), { ...ENV, NEXA_HOME_ASSISTANT_LIGHTS: 'switch.not_a_light' })
        .listAuthorizedLights(), error => error.code === 'home_assistant_configuration_invalid');
    assert.equal(calls, 0);
});

test('authorized light listing calls only allowlisted entities and sanitizes state', async () => {
    const calls = [];
    const client = clientWith(async (url, options) => { calls.push({ url: String(url), options }); return json(state('on')); });
    const lights = await client.listAuthorizedLights();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:8123/api/states/light.office');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-ha-token');
    assert.deepEqual(lights.map(({ entityId, name, state: current, supportsBrightness, supportsColor }) =>
        ({ entityId, name, state: current, supportsBrightness, supportsColor })),
    [{ entityId: 'light.office', name: 'Luz de prueba', state: 'on', supportsBrightness: true, supportsColor: true }]);
});

test('light state exposes only bounded Home Assistant effects and color representations', async () => {
    const client = clientWith(async () => json(stateFor('light.office', 'on', 'Test light', {
        effect: 'Ocean', effect_list: ['Party', 'Ocean', 'Ocean', '  Fireplace  ', '', 12],
        rgbw_color: [1, 2, 3, 4], color_temp_kelvin: 2700,
    })));
    const [light] = await client.listAuthorizedLights();
    assert.deepEqual(light.effectList, ['Party', 'Ocean', 'Fireplace']);
    assert.equal(light.effect, 'Ocean');
    assert.deepEqual(light.rgbwColor, [1, 2, 3, 4]);
    assert.equal(light.colorTemperatureKelvin, 2700);
});

test('light effect uses only the fixed turn_on service and confirms after a delayed state update', async () => {
    const calls = [];
    const waits = [];
    let reads = 0;
    const client = createHomeAssistantClient({ environment: ENV, timeoutMs: 1000,
        waitImpl: async ms => { waits.push(ms); },
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), method: options.method, body: options.body });
            if (options.method === 'POST') return json([], 200);
            reads++;
            return json(stateFor('light.office', 'on', 'Test light', {
                effect_list: ['Party', 'Ocean'], effect: reads >= 3 ? 'Ocean' : null,
            }));
        } });
    const result = await client.applyLightEffect({ entityId: 'light.office', effect: 'Ocean' });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.state.effect, 'Ocean');
    assert.deepEqual(waits, [100]);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls.find(call => call.method === 'POST').url, 'http://127.0.0.1:8123/api/services/light/turn_on');
    assert.deepEqual(JSON.parse(calls.find(call => call.method === 'POST').body), { entity_id: 'light.office', effect: 'Ocean' });
});

test('effect is not applied unless the authorized entity reports it and the observed state confirms it', async () => {
    let calls = 0;
    const unsupported = clientWith(async () => { calls++; return json(stateFor('light.office', 'on', 'Test light', { effect_list: ['Party'] })); });
    await assert.rejects(unsupported.applyLightEffect({ entityId: 'light.office', effect: 'Ocean' }),
        error => error.code === 'home_assistant_effect_not_supported');
    assert.equal(calls, 1);

    const waits = [];
    let reads = 0;
    const neverConfirms = createHomeAssistantClient({ environment: ENV, timeoutMs: 1000,
        waitImpl: async ms => { waits.push(ms); }, fetchImpl: async (url, options) => {
            if (options.method === 'POST') return json([], 200);
            reads++;
            return json(stateFor('light.office', 'on', 'Test light', { effect_list: ['Ocean'], effect: reads === 1 ? null : 'Party' }));
        } });
    const result = await neverConfirms.applyLightEffect({ entityId: 'light.office', effect: 'Ocean' });
    assert.equal(result.outcome, 'accepted_not_confirmed');
    assert.equal(waits.reduce((sum, delay) => sum + delay, 0), 3000);
});

test('conversational light control exposes an optional effect and reuses the existing effect operation', async () => {
    const calls = [];
    const client = {
        resolveLightReference: async reference => reference === 'Dormitorio'
            ? { status: 'resolved', entityId: 'light.office' } : { status: 'not_found' },
        applyLightEffect: async input => { calls.push(['effect', input]); return { success: true, outcome: 'confirmed',
            state: { entityId: 'light.office', state: 'on', effect: 'Ocean' } }; },
        controlLight: async input => { calls.push(['light', input]); return { success: true, outcome: 'confirmed', state: {} }; },
    };
    const control = createHomeAssistantRegistrations(client)[2];
    const effectProperty = control.definition.parameters.properties.effect;
    assert.deepEqual(effectProperty.type, ['string', 'null']);
    assert.equal(control.definition.parameters.additionalProperties, false);
    assert(control.definition.parameters.required.includes('effect'));
    const result = await control.execute({ args: { entity_id: 'Dormitorio', action: 'turn_on', brightness_pct: null,
        rgb_color: null, effect: 'Ocean' } });
    assert.deepEqual(result, { success: true, outcome: 'confirmed', state: { entityId: 'light.office', state: 'on', effect: 'Ocean' } });
    assert.deepEqual(calls, [['effect', { entityId: 'light.office', effect: 'Ocean' }]]);

    await control.execute({ args: { entity_id: 'Dormitorio', action: 'turn_on', brightness_pct: 35,
        rgb_color: null, effect: null } });
    assert.deepEqual(calls[1], ['light', { entityId: 'light.office', action: 'turn_on', brightnessPct: 35, rgbColor: null }]);
});

test('conversational effect control rejects mixed or malformed effects before invoking the client', async () => {
    let actions = 0;
    const client = { resolveLightReference: async () => ({ status: 'resolved', entityId: 'light.office' }),
        applyLightEffect: async () => { actions++; return { success: true }; },
        controlLight: async () => { actions++; return { success: true }; } };
    const control = createHomeAssistantRegistrations(client)[2];
    for (const args of [
        { entity_id: 'Bedroom', action: 'turn_on', brightness_pct: null, rgb_color: null, effect: '' },
        { entity_id: 'Bedroom', action: 'turn_on', brightness_pct: 20, rgb_color: null, effect: 'Ocean' },
        { entity_id: 'Bedroom', action: 'turn_off', brightness_pct: null, rgb_color: null, effect: 'Ocean' },
        { entity_id: 'Bedroom', action: 'turn_on', brightness_pct: null, rgb_color: null, effect: 'Ocean', service: 'light.turn_on' },
    ]) {
        const result = await control.execute({ args });
        assert.equal(result.error.code, 'home_assistant_arguments_invalid');
    }
    assert.equal(actions, 0);
});

test('effect tool path validates current allowlist and effect_list before a single fixed service call', async () => {
    const calls = [];
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), method: options.method, body: options.body });
        if (options.method === 'POST') return json([], 200);
        return json(stateFor('light.office', 'on', 'Desk', { effect_list: ['Ocean'], effect: 'Ocean' }));
    });
    const control = createHomeAssistantRegistrations(client)[2];
    const result = await control.execute({ args: { entity_id: 'light.office', action: 'turn_on', brightness_pct: null,
        rgb_color: null, effect: 'Ocean' } });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.state.effect, 'Ocean');
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls.find(call => call.method === 'POST').url, 'http://127.0.0.1:8123/api/services/light/turn_on');
    assert.deepEqual(JSON.parse(calls.find(call => call.method === 'POST').body), { entity_id: 'light.office', effect: 'Ocean' });

    const unsupportedCalls = [];
    const unsupportedClient = clientWith(async (url, options) => {
        unsupportedCalls.push({ url: String(url), method: options.method });
        return json(stateFor('light.office', 'on', 'Desk', { effect_list: ['Party'] }));
    });
    const unsupported = await createHomeAssistantRegistrations(unsupportedClient)[2].execute({ args: {
        entity_id: 'light.office', action: 'turn_on', brightness_pct: null, rgb_color: null, effect: 'Ocean' } });
    assert.equal(unsupported.error.code, 'home_assistant_effect_not_supported');
    assert.equal(unsupportedCalls.some(call => call.method === 'POST'), false);
});

test('conversational effects resolve authorized natural names and reject unsupported or ambiguous targets', async () => {
    const environment = { ...ENV, NEXA_HOME_ASSISTANT_LIGHTS: 'light.bedroom_ceiling,light.living',
        NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([
            { entityId: 'light.bedroom_ceiling', name: 'Techo Dormitorio', area: 'Sala' },
            { entityId: 'light.living', name: 'Living', area: 'Sala' },
        ]) };
    const calls = [];
    let requestedEffect = null;
    const client = createHomeAssistantClient({ environment, timeoutMs: 1000, waitImpl: async () => {},
        fetchImpl: async (url, options) => {
            const entityId = new URL(url).pathname.split('/').at(-1);
            calls.push({ entityId, method: options.method, body: options.body });
            if (options.method === 'POST') {
                requestedEffect = JSON.parse(options.body).effect;
                return json([], 200);
            }
            const effects = entityId === 'light.bedroom_ceiling' ? ['Ocean', 'TV time'] : ['Party'];
            const active = effects.includes(requestedEffect) ? requestedEffect : null;
            return json(stateFor(entityId, 'on', entityId, { effect_list: effects, effect: active }));
        } });
    const control = createHomeAssistantRegistrations(client)[2];
    for (const [reference, effect, expectedId] of [
        ['Techo Dormitorio', 'Ocean', 'light.bedroom_ceiling'],
        ['Living', 'Party', 'light.living'],
        ['Techo Dormitorio', 'TV time', 'light.bedroom_ceiling'],
    ]) {
        const result = await control.execute({ args: { entity_id: reference, action: 'turn_on', brightness_pct: null,
            rgb_color: null, effect } });
        assert.equal(result.outcome, 'confirmed');
        assert.equal(result.state.entityId, expectedId);
    }
    assert.equal(calls.filter(call => call.method === 'POST').length, 3);
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body)), [
        { entity_id: 'light.bedroom_ceiling', effect: 'Ocean' },
        { entity_id: 'light.living', effect: 'Party' },
        { entity_id: 'light.bedroom_ceiling', effect: 'TV time' },
    ]);

    const beforeUnsupported = calls.length;
    const unsupported = await control.execute({ args: { entity_id: 'Living', action: 'turn_on', brightness_pct: null,
        rgb_color: null, effect: 'Ocean' } });
    assert.equal(unsupported.error.code, 'home_assistant_effect_not_supported');
    assert.equal(calls.slice(beforeUnsupported).some(call => call.method === 'POST'), false);

    const beforeAmbiguous = calls.length;
    const ambiguous = await control.execute({ args: { entity_id: 'Sala', action: 'turn_on', brightness_pct: null,
        rgb_color: null, effect: 'Party' } });
    assert.equal(ambiguous.outcome, 'ambiguous');
    assert.equal(calls.slice(beforeAmbiguous).some(call => call.method === 'POST'), false);

    const beforeUnauthorized = calls.length;
    const unauthorized = await control.execute({ args: { entity_id: 'light.not_authorized', action: 'turn_on',
        brightness_pct: null, rgb_color: null, effect: 'Ocean' } });
    assert.equal(unauthorized.error.code, 'home_assistant_entity_not_authorized');
    assert.equal(calls.length, beforeUnauthorized);
});

test('effect writes fail closed when the persistent authorization Store is empty or invalid', async () => {
    let calls = 0;
    const empty = createHomeAssistantClient({ environment: ENV, authorizedLightsProvider: () => ({ ok: true, authorizedLights: [] }),
        fetchImpl: async () => { calls++; return json(state()); } });
    await assert.rejects(empty.applyLightEffect({ entityId: 'light.office', effect: 'Ocean' }),
        error => error.code === 'home_assistant_no_authorized_lights');
    const invalid = createHomeAssistantClient({ environment: ENV,
        authorizedLightsProvider: () => ({ ok: false, error: 'home_assistant_device_store_invalid' }),
        fetchImpl: async () => { calls++; return json(state()); } });
    await assert.rejects(invalid.applyLightEffect({ entityId: 'light.office', effect: 'Ocean' }),
        error => error.code === 'home_assistant_authorization_store_unavailable');
    assert.equal(calls, 0);
});

test('conversational effect tool keeps acceptance distinct from delayed confirmation and maps API errors safely', async () => {
    const waits = [];
    let reads = 0;
    let serviceCalls = 0;
    const delayedClient = clientWith(async (_url, options) => {
        if (options.method === 'POST') { serviceCalls++; return json([], 200); }
        reads++;
        return json(stateFor('light.office', 'on', 'Desk', { effect_list: ['Ocean'], effect: null }));
    }, ENV, async ms => { waits.push(ms); });
    const delayed = await createHomeAssistantRegistrations(delayedClient)[2].execute({ args: {
        entity_id: 'light.office', action: 'turn_on', brightness_pct: null, rgb_color: null, effect: 'Ocean' } });
    assert.equal(delayed.success, false);
    assert.equal(delayed.accepted, true);
    assert.equal(delayed.outcome, 'accepted_not_confirmed');
    assert.equal(waits.reduce((sum, delay) => sum + delay, 0), 3000);
    assert.equal(serviceCalls, 1);
    assert.ok(reads > 3);

    const failedClient = clientWith(async () => json({}, 401));
    const failed = await createHomeAssistantRegistrations(failedClient)[2].execute({ args: {
        entity_id: 'light.office', action: 'turn_on', brightness_pct: null, rgb_color: null, effect: 'Ocean' } });
    assert.equal(failed.success, false);
    assert.equal(failed.error.code, 'home_assistant_unauthorized');
});

test('client refuses entities outside its allowlist without a request', async () => {
    let calls = 0;
    const client = clientWith(async () => { calls++; return json(state()); });
    await assert.rejects(client.getEntity('light.other'), error => error.code === 'home_assistant_entity_not_authorized');
    assert.equal(calls, 0);
});

test('all three Home Assistant tools are registered with the existing model tool system', () => {
    const tools = getToolsForModel();
    const names = new Set(tools.map(tool => tool.name));
    assert(names.has('home_list_authorized_lights'));
    assert(names.has('home_get_light_state'));
    assert(names.has('home_control_light'));
    const control = tools.find(tool => tool.name === 'home_control_light');
    assert.deepEqual(control.parameters.properties.effect.type, ['string', 'null']);
    assert(control.description.includes('effectList'));
});

test('authorized lights listing tool returns only its client-provided allowlist', async () => {
    const [list] = createHomeAssistantRegistrations({ listAuthorizedLights: async () => [
        { entityId: 'light.office', name: 'Synthetic light', state: 'off', available: true },
    ] });
    const result = await list.execute({ args: {} });
    assert.equal(result.success, true);
    assert.equal(result.lights.length, 1);
    assert.equal(result.lights[0].entityId, 'light.office');
});
test('tool resolves an omitted entity only when a single authorized light exists', async () => {
    const client = { configuration: () => ({ entityIds: ['light.office'] }),
        getEntity: async entityId => ({ entityId, state: 'on', available: true }) };
    const [get] = createHomeAssistantRegistrations(client).slice(1, 2);
    assert.equal((await get.execute({ args: { entity_id: '' } })).success, true);
    const multiClient = { configuration: () => ({ entityIds: ['light.office', 'light.kitchen'] }), getEntity: async () => ({}) };
    const [multiGet] = createHomeAssistantRegistrations(multiClient).slice(1, 2);
    assert.equal((await multiGet.execute({ args: { entity_id: '' } })).error.code, 'home_assistant_entity_ambiguous');
});

test('metadata is limited to allowlisted entities and validated strictly', async () => {
    const client = clientWith(async url => {
        const id = new URL(url).pathname.split('/').at(-1);
        return json(stateFor(id, 'off', id === 'light.office' ? 'HA Office' : 'HA Kitchen'));
    }, MULTI_ENV);
    const lights = await client.listAuthorizedLights();
    assert.deepEqual(lights.map(({ entityId, name, friendlyName, area, aliases }) =>
        ({ entityId, name, friendlyName, area, aliases })), [
        { entityId: 'light.office', name: 'Luz de escritorio', friendlyName: 'HA Office', area: 'Escritorio',
            aliases: ['lámpara de trabajo'] },
        { entityId: 'light.kitchen', name: 'Luz de techo', friendlyName: 'HA Kitchen', area: 'Cocina', aliases: ['plafón'] },
    ]);
    const invalid = clientWith(async () => json({}), { ...ENV,
        NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([{ entityId: 'light.other', name: 'No autorizada' }]) });
    assert.throws(() => invalid.configuration(), error => error.code === 'home_assistant_configuration_invalid');
});

test('exact configured name and unique alias resolve to their authorized IDs', async () => {
    const calls = [];
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), method: options.method });
        const id = new URL(url).pathname.split('/').at(-1);
        return json(stateFor(id, 'on', id === 'light.office' ? 'Desk Light' : 'Kitchen Light'));
    }, MULTI_ENV);
    assert.deepEqual(await client.resolveLightReference('Luz de escritorio'),
        { status: 'resolved', entityId: 'light.office' });
    assert.deepEqual(await client.resolveLightReference('LÁMPARA DE TRABAJO'),
        { status: 'resolved', entityId: 'light.office' });
    assert.equal(calls.length, 4);
});

test('duplicate aliases and a shared room return authorized candidates instead of choosing one', async () => {
    const duplicateAliasEnv = { ...MULTI_ENV, NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([
        { entityId: 'light.office', name: 'Desk', aliases: ['Luz auxiliar'] },
        { entityId: 'light.kitchen', name: 'Ceiling', aliases: ['luz auxiliar'] },
    ]) };
    const duplicateAliasClient = clientWith(async url => {
        const id = new URL(url).pathname.split('/').at(-1);
        return json(stateFor(id));
    }, duplicateAliasEnv);
    const aliasResult = await duplicateAliasClient.resolveLightReference('Luz auxiliar');
    assert.equal(aliasResult.status, 'ambiguous');
    assert.deepEqual(aliasResult.candidates.map(candidate => candidate.entityId), ['light.office', 'light.kitchen']);

    const sharedRoomEnv = { ...MULTI_ENV, NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([
        { entityId: 'light.office', name: 'Desk', area: 'Sala' },
        { entityId: 'light.kitchen', name: 'Ceiling', area: 'Sala' },
    ]) };
    const sharedRoomClient = clientWith(async url => {
        const id = new URL(url).pathname.split('/').at(-1);
        return json(stateFor(id));
    }, sharedRoomEnv);
    assert.equal((await sharedRoomClient.resolveLightReference('sala')).status, 'ambiguous');
});

test('authorized IDs resolve directly; unauthorized IDs and unknown references are rejected', async () => {
    let calls = 0;
    const client = clientWith(async url => {
        calls++;
        const id = new URL(url).pathname.split('/').at(-1);
        return json(stateFor(id));
    }, MULTI_ENV);
    assert.deepEqual(await client.resolveLightReference('light.office'), { status: 'resolved', entityId: 'light.office' });
    assert.deepEqual(await client.resolveLightReference('light.not_authorized'), { status: 'not_authorized' });
    assert.equal(calls, 0);
    assert.deepEqual(await client.resolveLightReference('light del living'), { status: 'not_found' });
    assert.equal(calls, 2);
});

test('tool boundary resolves a unique alias before controlling only that light once', async () => {
    const calls = [];
    const client = clientWith(async (url, options) => {
        const parsed = new URL(url);
        calls.push({ path: parsed.pathname, method: options.method, body: options.body });
        if (options.method === 'POST') return json([], 200);
        const id = parsed.pathname.split('/').at(-1);
        return json(stateFor(id, 'on', id === 'light.office' ? 'Desk Light' : 'Kitchen Light'));
    }, MULTI_ENV);
    const control = createHomeAssistantRegistrations(client)[2];
    const result = await control.execute({ args: { entity_id: 'lámpara de trabajo', action: 'turn_on',
        brightness_pct: null, rgb_color: null } });
    assert.equal(result.success, true);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls.find(call => call.method === 'POST').path, '/api/services/light/turn_on');
    assert.deepEqual(JSON.parse(calls.find(call => call.method === 'POST').body), { entity_id: 'light.office' });
});

test('tools expose ambiguous authorized candidates and reject unknown descriptions', async () => {
    const environment = { ...MULTI_ENV, NEXA_HOME_ASSISTANT_LIGHT_METADATA: JSON.stringify([
        { entityId: 'light.office', name: 'Desk', area: 'Sala' },
        { entityId: 'light.kitchen', name: 'Ceiling', area: 'Sala' },
    ]) };
    const client = clientWith(async url => {
        const id = new URL(url).pathname.split('/').at(-1);
        return json(stateFor(id));
    }, environment);
    const get = createHomeAssistantRegistrations(client)[1];
    const ambiguous = await get.execute({ args: { entity_id: 'Sala' } });
    assert.equal(ambiguous.outcome, 'ambiguous');
    assert.deepEqual(ambiguous.candidates.map(candidate => candidate.entityId), ['light.office', 'light.kitchen']);
    const unknown = await get.execute({ args: { entity_id: 'lámpara del jardín' } });
    assert.equal(unknown.error.code, 'home_assistant_light_reference_not_found');
});

test('control uses a fixed service endpoint and confirms immediately without an extra wait', async () => {
    const calls = [];
    let waits = 0;
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === 'POST') return json([], 200);
        return json(state('on'));
    }, ENV, async () => { waits++; });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    assert.equal(calls.length, 3);
    assert.equal(waits, 0);
    assert.equal(calls[1].url, 'http://127.0.0.1:8123/api/services/light/turn_on');
    assert.deepEqual(JSON.parse(calls[1].options.body), { entity_id: 'light.office' });
    assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-ha-token');
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'confirmed');
});

test('turn-off uses only the fixed turn_off service and confirms off state', async () => {
    const calls = [];
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === 'POST') return json([], 200);
        return json(state('off'));
    });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_off' });
    assert.equal(calls[1].url, 'http://127.0.0.1:8123/api/services/light/turn_off');
    assert.deepEqual(JSON.parse(calls[1].options.body), { entity_id: 'light.office' });
    assert.equal(result.success, true);
});
test('brightness and RGB are validated, sent and checked in the observed state', async () => {
    const calls = [];
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), options });
        if (options.method === 'POST') return json([], 200);
        return json(state('on', { brightness: 128, rgb_color: [12, 19, 31] }));
    });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on', brightnessPct: 50,
        rgbColor: [10, 20, 30] });
    assert.deepEqual(JSON.parse(calls[1].options.body), { entity_id: 'light.office', brightness_pct: 50,
        rgb_color: [10, 20, 30] });
    assert.equal(result.success, true);
});

test('a transient observation failure is retried but never treated as confirmation', async () => {
    const waits = [];
    let stateReads = 0;
    const client = clientWith(async (_url, options) => {
        if (options.method === 'POST') return json([], 200);
        stateReads++;
        if (stateReads === 2) throw new Error('synthetic transient read failure');
        return json(state(stateReads > 3 ? 'on' : 'off'));
    }, ENV, async ms => { waits.push(ms); });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.state.state, 'on');
    assert.equal(stateReads, 4);
    assert.equal(waits.length, 2);
    assert.ok(waits.every(delay => delay < 3000));
});

test('a stale first state is confirmed by adaptive reads without repeating the action', async () => {
    const calls = [];
    const waits = [];
    let stateReads = 0;
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), method: options.method });
        if (options.method === 'POST') return json([], 200);
        stateReads++;
        return json(state(stateReads < 3 ? 'off' : 'on'));
    }, ENV, async ms => { waits.push(ms); });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'confirmed');
    assert.deepEqual(waits, [100]);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(calls.filter(call => call.method !== 'POST').length, 3);
});

test('state that never updates remains accepted_not_confirmed within the bounded polling window', async () => {
    const calls = [];
    const waits = [];
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), method: options.method });
        return options.method === 'POST' ? json([], 200) : json(state('off'));
    }, ENV, async ms => { waits.push(ms); });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'accepted_not_confirmed');
    assert.equal(waits.reduce((sum, delay) => sum + delay, 0), 3000);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
    assert.ok(calls.filter(call => call.method !== 'POST').length > 3);
});

test('a failed delayed state read never reports confirmation', async () => {
    const calls = [];
    const waits = [];
    const client = clientWith(async (url, options) => {
        calls.push({ url: String(url), method: options.method });
        if (options.method === 'POST') return json([], 200);
        if (calls.filter(call => call.method !== 'POST').length >= 2)
            throw new Error('synthetic network failure');
        return json(state('off'));
    }, ENV, async ms => { waits.push(ms); });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'accepted_not_confirmed');
    assert.equal(result.errorCode, 'home_assistant_unavailable');
    assert.equal(waits.reduce((sum, delay) => sum + delay, 0), 3000);
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('an unresponsive post-action state endpoint is cut off by the remaining verification budget', async () => {
    let stateReads = 0;
    let serviceCalls = 0;
    const startedAt = performance.now();
    const client = createHomeAssistantClient({ environment: ENV, timeoutMs: 10_000,
        fetchImpl: async (_url, options) => {
            if (options.method === 'POST') { serviceCalls++; return json([], 200); }
            stateReads++;
            if (stateReads === 1) return json(state('off'));
            return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
                () => reject(Object.assign(new Error('synthetic abort'), { name: 'AbortError' })), { once: true }));
        } });
    const result = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(result.outcome, 'accepted_not_confirmed');
    assert.equal(result.errorCode, 'home_assistant_timeout');
    assert.equal(serviceCalls, 1);
    assert.equal(stateReads, 2);
    assert.ok(elapsedMs >= 2800 && elapsedMs < 3800, `verification took ${elapsedMs} ms`);
});

test('unsupported features, unavailable device, timeout and auth errors are safe', async () => {
    const unavailable = clientWith(async () => json(state('unavailable')));
    await assert.rejects(unavailable.controlLight({ entityId: 'light.office', action: 'turn_on' }),
        error => error.code === 'home_assistant_entity_unavailable');
    const unsupported = clientWith(async () => json(state('on', { supported_color_modes: ['onoff'], brightness: null })));
    await assert.rejects(unsupported.controlLight({ entityId: 'light.office', action: 'turn_on', brightnessPct: 30 }),
        error => error.code === 'home_assistant_brightness_unsupported');
    const colorUnsupported = clientWith(async () => json(state('on', {
        supported_color_modes: ['onoff', 'brightness'], brightness: 100, rgb_color: null,
    })));
    await assert.rejects(colorUnsupported.controlLight({ entityId: 'light.office', action: 'turn_on', rgbColor: [0, 0, 255] }),
        error => error.code === 'home_assistant_color_unsupported');
    const timedOut = clientWith(async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })));
    }));
    await assert.rejects(timedOut.getEntity('light.office'), error => error.code === 'home_assistant_timeout');
    const unauthorized = clientWith(async () => json({}, 401));
    await assert.rejects(unauthorized.getEntity('light.office'), error => error.code === 'home_assistant_unauthorized'
        && !error.message.includes(ENV.NEXA_HOME_ASSISTANT_TOKEN));
});

test('registered tools validate parameters and enforce action permission through the dispatcher', async () => {
    const [list, get, control] = createHomeAssistantRegistrations({
        configuration: () => ({ entityIds: ['light.office'] }), listAuthorizedLights: async () => [],
        getEntity: async () => ({ state: 'off', available: true }), controlLight: async () => ({ success: true }),
    });
    assert.deepEqual([list.definition.name, get.definition.name, control.definition.name],
        ['home_list_authorized_lights', 'home_get_light_state', 'home_control_light']);
    const invalid = await control.execute({ args: { entity_id: 'light.office', action: 'turn_on', brightness_pct: 101,
        rgb_color: null } });
    assert.equal(invalid.success, false);
    assert.equal(invalid.error.code, 'home_assistant_arguments_invalid');
    const denied = await executeTool('home_control_light', { entity_id: '', action: 'turn_on', brightness_pct: null,
        rgb_color: null }, { permissionPolicy: { ...defaultPermissionPolicy, action: false } });
    assert.equal(denied.success, false);
    assert.equal(denied.error.code, 'permission_denied');
});

test('Desktop authorization provider is the live allowlist and ignores the legacy environment list', async () => {
    let authorizedLights = [{ entityId: 'light.office', name: 'Study lamp', area: 'Office', aliases: ['desk light'] }];
    const calls = [];
    const client = createHomeAssistantClient({ environment: { ...ENV, NEXA_HOME_ASSISTANT_LIGHTS: 'light.legacy' },
        authorizedLightsProvider: () => ({ ok: true, version: 1, source: 'store', authorizedLights }),
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), method: options.method });
            const id = new URL(url).pathname.split('/').at(-1);
            return json(stateFor(id, 'on', id));
        }, timeoutMs: 1000, waitImpl: async () => {} });
    const registrations = createHomeAssistantRegistrations(client);
    const listed = await registrations[0].execute({ args: {} });
    assert.deepEqual(listed.lights.map(light => light.entityId), ['light.office']);
    assert.equal((await registrations[1].execute({ args: { entity_id: 'desk light' } })).success, true);
    assert.equal((await registrations[1].execute({ args: { entity_id: 'light.legacy' } })).error.code,
        'home_assistant_entity_not_authorized');
    assert.equal(calls.some(call => call.url.endsWith('/light.legacy')), false);

    authorizedLights = [{ entityId: 'light.office', name: 'Study lamp', aliases: ['reading lamp'] }];
    assert.equal((await registrations[1].execute({ args: { entity_id: 'desk light' } })).error.code,
        'home_assistant_light_reference_not_found');
    assert.equal((await registrations[1].execute({ args: { entity_id: 'reading lamp' } })).success, true);
});

test('effect-speed associations remain separate from validated REST light metadata', async () => {
    const authorizedLights = [
        { entityId: 'light.office', name: 'Study lamp', area: 'Office', aliases: ['desk'],
            effectSpeedEntityId: 'number.office_effect_speed' },
        { entityId: 'light.kitchen', name: 'Kitchen lamp', area: 'Kitchen', aliases: [],
            effectSpeedEntityId: 'number.kitchen_effect_speed' },
    ];
    const calls = [];
    const client = createHomeAssistantClient({ environment: ENV,
        authorizedLightsProvider: () => ({ ok: true, authorizedLights }),
        fetchImpl: async url => {
            const entityId = new URL(url).pathname.split('/').at(-1);
            calls.push(entityId);
            return json(stateFor(entityId, 'on', entityId));
        }, timeoutMs: 1000 });

    assert.deepEqual(client.configuration().entityIds, ['light.office', 'light.kitchen']);
    assert.deepEqual(client.configuration().lightMetadata, [
        { entityId: 'light.office', name: 'Study lamp', area: 'Office', aliases: ['desk'] },
        { entityId: 'light.kitchen', name: 'Kitchen lamp', area: 'Kitchen', aliases: [] },
    ]);
    const lights = await client.listAuthorizedLights();
    assert.deepEqual(lights.map(light => light.entityId), ['light.office', 'light.kitchen']);
    assert.deepEqual(calls, ['light.office', 'light.kitchen']);
    const control = await client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    assert.equal(control.outcome, 'confirmed');
});

test('invalid or empty persistent authorization fails closed without falling back to env', async () => {
    let calls = 0;
    const invalid = createHomeAssistantClient({ environment: ENV,
        authorizedLightsProvider: () => ({ ok: false, error: 'home_assistant_device_store_invalid' }),
        fetchImpl: async () => { calls++; return json(state()); }, timeoutMs: 1000 });
    assert.throws(() => invalid.configuration(), error => error.code === 'home_assistant_authorization_store_unavailable');
    await assert.rejects(invalid.getEntity('light.office'), error => error.code === 'home_assistant_authorization_store_unavailable');

    const empty = createHomeAssistantClient({ environment: ENV,
        authorizedLightsProvider: () => ({ ok: true, authorizedLights: [] }),
        fetchImpl: async () => { calls++; return json(state()); }, timeoutMs: 1000 });
    assert.throws(() => empty.configuration(), error => error.code === 'home_assistant_no_authorized_lights');
    assert.equal(calls, 0);
});

test('revocation during a pending pre-action read blocks the physical service call', async () => {
    let authorized = true;
    let releaseRead;
    let stateReadStarted;
    const readStarted = new Promise(resolve => { stateReadStarted = resolve; });
    const readGate = new Promise(resolve => { releaseRead = resolve; });
    const calls = [];
    const client = createHomeAssistantClient({ environment: ENV,
        authorizedLightsProvider: () => ({ ok: true, authorizedLights: authorized ? [{ entityId: 'light.office' }] : [] }),
        fetchImpl: async (url, options) => {
            calls.push({ url: String(url), method: options.method });
            if (options.method === 'POST') return json([], 200);
            stateReadStarted();
            await readGate;
            return json(stateFor('light.office', 'off'));
        }, timeoutMs: 1000, waitImpl: async () => {} });
    const pending = client.controlLight({ entityId: 'light.office', action: 'turn_on' });
    await readStarted;
    authorized = false;
    releaseRead();
    await assert.rejects(pending, error => error.code === 'home_assistant_no_authorized_lights');
    assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('runtime executor preserves tool permissions and exposes no device administration operations', async () => {
    const { createToolExecutor } = await import('../src/tools/index.js');
    const [list, get, control] = createHomeAssistantRegistrations({ configuration: () => ({ entityIds: ['light.office'] }),
        listAuthorizedLights: async () => [], getEntity: async () => ({ state: 'off', available: true }),
        controlLight: async () => ({ success: true, state: { state: 'on' } }) });
    const execute = createToolExecutor([list, get, control]);
    assert.equal((await execute('home_control_light', { entity_id: '', action: 'turn_on', brightness_pct: null,
        rgb_color: null }, { permissionPolicy: { ...defaultPermissionPolicy, action: false } })).error.code, 'permission_denied');
    await assert.rejects(execute('home_authorize_light', {}, {}), /Herramienta desconocida/);
    assert.equal(getToolsForModel().some(tool => typeof tool.name === 'string' && tool.name.startsWith('home_authorize_')), false);
});



test('Home Assistant tools are offered only while the persistent authorization Store is valid and non-empty', () => {
    let authorization = { ok: false, error: 'home_assistant_device_store_invalid' };
    const selector = createHomeAssistantToolSelector({
        getTools: () => [{ name: 'home_list_authorized_lights' }, { name: 'home_get_light_state' },
            { name: 'home_control_light' }, { name: 'spotify_search' }],
        authorizationProvider: () => authorization,
    });
    assert.deepEqual(selector().map(tool => tool.name), ['spotify_search']);
    authorization = { ok: true, authorizedLights: [] };
    assert.deepEqual(selector().map(tool => tool.name), ['spotify_search']);
    authorization = { ok: true, authorizedLights: [{ entityId: 'light.office' }] };
    assert.deepEqual(selector().map(tool => tool.name), ['home_list_authorized_lights', 'home_get_light_state',
        'home_control_light', 'spotify_search']);
    authorization = { ok: false, error: 'home_assistant_device_store_io_error' };
    assert.deepEqual(selector().map(tool => tool.name), ['spotify_search']);
});
