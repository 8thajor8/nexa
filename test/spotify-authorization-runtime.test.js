import assert from 'node:assert/strict';
import test from 'node:test';
import { authorizeSpotify } from '../src/integrations/spotify/auth.js';
import { createSpotifyAuthorizationRuntime } from '../src/integrations/spotify/authorization-runtime.js';

const environment = { SPOTIFY_CLIENT_ID: 'synthetic-client-id' };

function response(status, payload) {
    return { status, ok: status >= 200 && status < 300, json: async () => payload };
}

function store(initial = null) {
    let current = initial;
    const saved = [];
    return {
        saved,
        async load() { return current; },
        async save(tokens) { current = tokens; saved.push(structuredClone(tokens)); },
    };
}

async function callCallback(url) {
    const result = await fetch(url);
    return { status: result.status, text: await result.text() };
}

test('status distinguishes an unconnected account without exposing credentials', async () => {
    const tokenStore = store();
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore,
        fetchImpl: async () => { throw new Error('should not contact Spotify'); } });
    assert.deepEqual(await runtime.getStatus(), { status: 'not_connected' });
    await runtime.close();
});

test('status reuses a valid session and reports only connection state', async () => {
    const tokenStore = store({ accessToken: 'access-secret', refreshToken: 'refresh-secret',
        expiresAt: Date.now() + 60_000, scope: [] });
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore,
        fetchImpl: async () => { throw new Error('a valid access token must be reused'); } });
    const status = await runtime.getStatus();
    assert.deepEqual(status, { status: 'connected' });
    assert.doesNotMatch(JSON.stringify(status), /access-secret|refresh-secret/u);
    const flow = await runtime.startAuthorization();
    assert.equal(flow.alreadyConnected, true);
    assert.equal(flow.authorizationUrl, null);
    assert.deepEqual(await flow.completion, { status: 'connected' });
    await runtime.close();
});

test('expired credentials refresh and persist without returning tokens', async () => {
    const tokenStore = store({ accessToken: 'expired-access', refreshToken: 'refresh-secret', expiresAt: 0, scope: [] });
    let requests = 0;
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore,
        fetchImpl: async (url, options) => {
            requests++;
            assert.equal(String(url), 'https://accounts.spotify.com/api/token');
            assert.equal(options.body.get('grant_type'), 'refresh_token');
            return response(200, { access_token: 'new-access-secret', expires_in: 3600 });
        } });
    assert.deepEqual(await runtime.getStatus(), { status: 'connected' });
    assert.equal(requests, 1);
    assert.equal(tokenStore.saved.length, 1);
    assert.equal(tokenStore.saved[0].refreshToken, 'refresh-secret');
    assert.equal(JSON.stringify(await runtime.getStatus()).includes('new-access-secret'), false);
    await runtime.close();
});

test('invalid refresh credentials report reauthorization without exposing provider details', async () => {
    const tokenStore = store({ accessToken: 'expired-access', refreshToken: 'revoked-refresh', expiresAt: 0, scope: [] });
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore,
        fetchImpl: async () => response(400, { error: 'invalid_grant', error_description: 'revoked-refresh must not leak' }) });
    const status = await runtime.getStatus();
    assert.equal(status.status, 'reauthorization_required');
    assert.equal(status.error.code, 'spotify_reauthorization_required');
    assert.doesNotMatch(JSON.stringify(status), /revoked-refresh/u);
    await runtime.close();
});

test('explicit PKCE flow persists credentials, returns no tokens, and releases its lock', async () => {
    const tokenStore = store();
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore,
        fetchImpl: async (url, options) => {
            assert.equal(String(url), 'https://accounts.spotify.com/api/token');
            assert.equal(options.body.get('grant_type'), 'authorization_code');
            assert.equal(options.body.get('client_secret'), null);
            return response(200, { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 });
        } });
    const flow = await runtime.startAuthorization();
    const authorizationUrl = new URL(flow.authorizationUrl);
    assert.equal(authorizationUrl.origin, 'https://accounts.spotify.com');
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizationUrl.searchParams.get('state'));
    const callback = await callCallback(`http://127.0.0.1:8888/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}&code=synthetic-code`);
    assert.equal(callback.status, 200);
    assert.deepEqual(await flow.completion, { status: 'connected' });
    assert.equal(tokenStore.saved.length, 1);
    assert.doesNotMatch(JSON.stringify(await runtime.getStatus()), /access-secret|refresh-secret/u);
    await runtime.close();
});

test('CLI authorizeSpotify retains its URL output and completion behavior', async () => {
    const tokenStore = store();
    let output = '';
    const pending = authorizeSpotify({ environment, tokenStore,
        fetchImpl: async () => response(200, { access_token: 'cli-access', refresh_token: 'cli-refresh', expires_in: 3600 }),
        output: value => { output = value; } });
    // authorizeSpotify prints after its callback listener is ready, while its
    // returned promise remains pending for the callback as before.
    for (let attempt = 0; !output && attempt < 20; attempt += 1) await new Promise(resolve => setImmediate(resolve));
    assert.ok(output, 'CLI should print the generated URL after the callback listener is ready');
    const authorizationUrl = new URL(output.slice(output.lastIndexOf('\n') + 1));
    const callback = await callCallback(`http://127.0.0.1:8888/callback?state=${encodeURIComponent(authorizationUrl.searchParams.get('state'))}&code=cli-code`);
    assert.equal(callback.status, 200);
    assert.match(output, /^Abrí este enlace para autorizar Nexa con Spotify:\nhttps:\/\/accounts\.spotify\.com/u);
    const tokens = await pending;
    assert.equal(tokens.accessToken, 'cli-access');
    assert.equal(tokenStore.saved[0].refreshToken, 'cli-refresh');
});

test('authorization is single-flight and can be cancelled cooperatively', async () => {
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore: store() });
    const flow = await runtime.startAuthorization();
    await assert.rejects(runtime.startAuthorization(), error => error.code === 'spotify_authorization_in_progress');
    assert.equal(flow.cancel(), true);
    assert.deepEqual(await flow.completion, { status: 'cancelled' });
    assert.equal(flow.cancel(), false);
    await runtime.close();
});

test('callback state failures return sanitized errors and provider denial is cancellation', async () => {
    const runtime = createSpotifyAuthorizationRuntime({ environment, tokenStore: store() });
    const invalidStateFlow = await runtime.startAuthorization();
    const invalidStateUrl = new URL(invalidStateFlow.authorizationUrl);
    const invalid = await callCallback('http://127.0.0.1:8888/callback?state=wrong&code=synthetic-code');
    assert.equal(invalid.status, 400);
    const invalidStateResult = await invalidStateFlow.completion;
    assert.equal(invalidStateResult.status, 'error');
    assert.equal(invalidStateResult.error.code, 'spotify_state_mismatch');
    assert.equal(JSON.stringify(invalidStateResult).includes(invalidStateUrl.searchParams.get('state')), false);

    const deniedFlow = await runtime.startAuthorization();
    const deniedState = new URL(deniedFlow.authorizationUrl).searchParams.get('state');
    const denied = await callCallback(`http://127.0.0.1:8888/callback?state=${encodeURIComponent(deniedState)}&error=access_denied`);
    assert.equal(denied.status, 400);
    assert.deepEqual(await deniedFlow.completion, { status: 'cancelled' });
    await runtime.close();
});
