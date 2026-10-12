import assert from 'node:assert/strict';
import test from 'node:test';

import { LifeguardClient, validateLifeguardSearch } from '../src/integrations/lifeguard/client.js';
import { createConversationRuntime } from '../src/core/conversation-runtime.js';
import { executeTool, getToolsForModel, localToolRegistry } from '../src/tools/index.js';
import { toolPermissions } from '../src/tools/permissions.js';
import { getAutomaticMemoryToolSource } from '../src/memory/automatic/source-registry.js';

const token = 'synthetic-token-never-real';
const env = { LIFEGUARD_API_BASE_URL: 'https://crm.example.test', LIFEGUARD_API_TOKEN: token };
const incident = {
    reference: 'IN-1234', attention_date: '2026-01-02', created_date: '2026-01-01',
    service: { name: 'Servicio sintético' }, cancelled: false, provider: { name: 'Prestador sintético' },
    status: { gop: 'Pendiente', medical_report: null, billing: 'No enviada' },
    patient: { display_name: 'Paciente sintético' }, insurance: { name: 'Seguro sintético', external_reference: 'EXT-001' },
    case: { reference: 'LG-1000', status: 'Creado' }, clinical_text: 'EXCLUDED_SYNTHETIC_MARKER',
};
function response(status, body, headers = {}) {
    return { status, ok: status >= 200 && status < 300,
        headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body };
}
function clientFor(status, body, capture = () => {}, headers = {}) {
    return new LifeguardClient({ environment: env, fetchImpl: async (...args) => {
        capture(...args); return response(status, body, headers);
    } });
}

test('search validates documented filters, inclusive date pairs, limits and rejects unknown fields', () => {
    assert.deepEqual(validateLifeguardSearch({ provider_name: '  Clínica  ', limit: 20 }), { provider_name: 'Clínica', limit: 20 });
    assert.equal(validateLifeguardSearch({}), null);
    assert.equal(validateLifeguardSearch({ limit: 10 }), null);
    assert.equal(validateLifeguardSearch({ patient_name: 'ab' }), null);
    assert.equal(validateLifeguardSearch({ patient_name: 'abc', patient_email: 'x' }), null);
    assert.equal(validateLifeguardSearch({ provider_name: 'abc', limit: 21 }), null);
    assert.equal(validateLifeguardSearch({ attention_date_from: '2026-02-01' }), null);
    assert.equal(validateLifeguardSearch({ attention_date_from: '2026-02-02', attention_date_to: '2026-02-01' }), null);
    assert.equal(validateLifeguardSearch({ attention_date_from: '2026-01-01', attention_date_to: '2026-02-01' }), null);
    assert.equal(validateLifeguardSearch({ incident_reference: 'IN-123' }), null);
});

test('search sends exact documented POST, bearer stays out of returned data and projection excludes extras', async () => {
    let request;
    const client = clientFor(200, { success: true, data: { results: [incident], limit: 10, has_more: true } }, (...args) => { request = args; });
    const result = await client.search({ provider_name: 'Prestador', limit: 10 });
    assert.equal(request[0].href, 'https://crm.example.test/api/v1/nexa/incidents/search');
    assert.equal(request[1].method, 'POST');
    assert.equal(request[1].redirect, 'error');
    assert.equal(request[1].headers.Authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(request[1].body), { provider_name: 'Prestador', limit: 10 });
    assert.deepEqual(result.results, [{ reference: 'IN-1234', attention_date: '2026-01-02', created_date: '2026-01-01',
        service: { name: 'Servicio sintético' }, cancelled: false, provider: { name: 'Prestador sintético' },
        status: { gop: 'Pendiente', medical_report: null, billing: 'No enviada' }, patient: { display_name: 'Paciente sintético' },
        insurance: { name: 'Seguro sintético', external_reference: 'EXT-001' }, case: { reference: 'LG-1000', status: 'Creado' } }]);
    assert.equal(result.has_more, true);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(JSON.stringify(result).includes('EXCLUDED_SYNTHETIC_MARKER'), false);
});

test('search preserves successful empty results and has_more without inventing pagination', async () => {
    const result = await clientFor(200, { success: true, data: { results: [], limit: 10, has_more: false } })
        .search({ service_name: 'Traslado' });
    assert.deepEqual(result.results, []);
    assert.equal(result.has_more, false);
});

test('exact read uses the documented path and rejects invalid references before transport', async () => {
    let request; const client = clientFor(200, { success: true, data: { incident } }, (...args) => { request = args; });
    const result = await client.read('IN-1234');
    assert.equal(request[0].href, 'https://crm.example.test/api/v1/nexa/incidents/IN-1234');
    assert.equal(request[1].method, 'GET'); assert.equal(result.incident.reference, 'IN-1234');
    let calls = 0;
    const invalid = await new LifeguardClient({ environment: env, fetchImpl: async () => { calls++; } }).read('IN-1');
    assert.equal(invalid.error.code, 'lifeguard_reference_invalid'); assert.equal(calls, 0);
});

test('HTTP statuses map to bounded errors with no response body or token disclosure', async () => {
    const cases = [[400, 'lifeguard_request_invalid'], [401, 'lifeguard_authentication_failed'],
        [403, 'lifeguard_permission_denied'], [404, 'incident_not_found'], [409, 'ambiguous'],
        [413, 'lifeguard_request_invalid'], [415, 'lifeguard_request_invalid'], [429, 'lifeguard_rate_limited'],
        [500, 'lifeguard_service_unavailable'], [503, 'lifeguard_service_unavailable']];
    for (const [status, code] of cases) {
        const result = await clientFor(status, { secret: token, message: 'sensitive response detail' }).read('IN-1234');
        assert.equal(result.error.code, code);
        assert.equal(JSON.stringify(result).includes(token), false);
        assert.equal(JSON.stringify(result).includes('sensitive response detail'), false);
    }
});

test('missing config, insecure URL, timeout, network error, malformed response and 5xx are safe; no retries', async () => {
    let calls = 0;
    const missing = await new LifeguardClient({ environment: {}, fetchImpl: async () => { calls++; } }).search({ provider_name: 'ABC' });
    assert.equal(missing.error.code, 'lifeguard_not_configured'); assert.equal(calls, 0);
    const insecure = await new LifeguardClient({ environment: { ...env, LIFEGUARD_API_BASE_URL: 'http://crm.example.test' }, fetchImpl: async () => { calls++; } }).search({ provider_name: 'ABC' });
    assert.equal(insecure.error.code, 'lifeguard_not_configured'); assert.equal(calls, 0);
    const timeout = await new LifeguardClient({ environment: env, fetchImpl: async () => { calls++; throw Object.assign(new Error('private'), { name: 'TimeoutError' }); } }).search({ provider_name: 'ABC' });
    assert.equal(timeout.error.code, 'lifeguard_timeout'); assert.equal(calls, 1);
    const network = await new LifeguardClient({ environment: env, fetchImpl: async () => { calls++; throw new Error(token); } }).search({ provider_name: 'ABC' });
    assert.equal(network.error.code, 'lifeguard_network_error'); assert.equal(JSON.stringify(network).includes(token), false);
    const malformed = await clientFor(200, { success: true, data: { results: [{ ...incident, cancelled: 'false' }], limit: 10, has_more: false } }).search({ provider_name: 'ABC' });
    assert.equal(malformed.error.code, 'lifeguard_response_invalid');
    assert.equal(calls, 2);
});

test('only two read tools are registered with external-read permissions and Lifeguard provenance', () => {
    for (const name of ['lifeguard_search_incidents', 'lifeguard_read_incident']) {
        assert.ok(localToolRegistry.has(name)); assert.ok(getToolsForModel().some(tool => tool.name === name));
        assert.equal(toolPermissions[name], 'external_read');
        assert.equal(getAutomaticMemoryToolSource(name).source, 'api:lifeguard');
        assert.equal(getAutomaticMemoryToolSource(name).memoryPolicy, 'never_store');
    }
    assert.equal(localToolRegistry.has('lifeguard_write_incident'), false);
});

test('Desktop conversation runtime reaches Lifeguard tool through a synthetic HTTP provider', async () => {
    let calls = 0;
    const fakeClient = new LifeguardClient({ environment: env, fetchImpl: async () => {
        calls++; return response(200, { success: true, data: { incident } });
    } });
    const runtime = createConversationRuntime({ agentFactory: async () => ({
        async run() {
            const result = await executeTool('lifeguard_read_incident', { reference: 'IN-1234' }, { lifeguardClient: fakeClient });
            return JSON.stringify(result);
        }, async close() {},
    }) });
    try {
        const id = runtime.createConversation();
        const result = await runtime.sendMessage({ conversationId: id, requestId: 'lifeguard-synthetic-1', text: 'consulta sintética', source: 'typed' });
        assert.equal(result.status, 'completed'); assert.equal(calls, 1);
        assert.equal(JSON.parse(result.text).incident.reference, 'IN-1234');
        assert.equal(result.text.includes(token), false);
    } finally { await runtime.close(); }
});
