import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createSpotifyAuthorizationUrl, exchangeSpotifyAuthorizationCode, getSpotifyAccessToken, refreshSpotifyTokens, spotifyScopes } from '../src/integrations/spotify/auth.js';
import { SpotifyClient } from '../src/integrations/spotify/client.js';
import {
    getCurrentSpotifyTrack,
    getSpotifyDevices,
    ensureSpotifyDevice,
    nextSpotifyTrack,
    pauseSpotify,
    playSpotify,
    previousSpotifyTrack,
} from '../src/integrations/spotify/playback.js';
import { searchSpotify } from '../src/integrations/spotify/search.js';
import { executeTool, getToolsForModel, localToolRegistry } from '../src/tools/index.js';
import { defaultPermissionPolicy, toolPermissions } from '../src/tools/permissions.js';
import { formatSpotifyToolResult, spotifyModelSafeOutput } from '../src/tools/spotify.js';

function response(status, payload = null, headers = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        json: async () => payload,
    };
}

const track = {
    name: 'Hypnotized',
    artists: [{ name: 'Purple Disco Machine' }],
    album: { name: 'Exotica' },
    duration_ms: 200000,
    uri: 'spotify:track:abc123',
    external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
};

const recoveredDevice = { id: 'desktop-123', name: 'Spotify Desktop', type: 'computer', is_active: false, is_restricted: false };

function recoveryAdapters(overrides = {}) {
    return {
        isSpotifyRunning: async () => ({ success: true, running: false }),
        openSpotify: async () => ({ success: true }),
        focusSpotify: async () => ({ success: true }),
        getActiveWindow: async () => ({ success: true, window: null }),
        playPause: async () => ({ success: true }),
        wait: async () => {},
        ...overrides,
    };
}

function spotifyNoDevice() {
    return Object.assign(new Error('No device'), { code: 'spotify_no_device' });
}

test('spotify_search validates queries, limits results, normalizes items and links to Spotify', async () => {
    let request;
    const result = await searchSpotify('Hypnotized', 'track', {
        client: { request: async (...args) => {
            request = args;
            return { tracks: { items: [track] } };
        } },
    });
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.results[0].name, 'Hypnotized');
    assert.equal(result.results[0].spotifyUrl, 'https://open.spotify.com/track/abc123');
    assert.equal(request[0], '/search');
    assert.deepEqual(request[1].query, { q: 'Hypnotized', type: 'track', limit: '5' });
    assert.equal((await searchSpotify('  ', 'track')).error.code, 'spotify_query_invalid');
});

test('spotify_play searches first, plays a real exact URI and reports API confirmation', async () => {
    const calls = [];
    const result = await playSpotify({
        query: 'Hypnotized de Purple Disco Machine',
        type: 'track',
        client: { request: async (...args) => {
            calls.push(args);
            return args[0] === '/search' ? { tracks: { items: [track] } } : null;
        } },
    });
    assert.equal(result.success, true);
    assert.equal(result.confirmed, true);
    assert.equal(result.selected.name, 'Hypnotized');
    assert.deepEqual(calls.map(([endpoint, options]) => [endpoint, options.method, options.body]), [
        ['/search', undefined, undefined],
        ['/me/player/play', 'PUT', { uris: ['spotify:track:abc123'] }],
    ]);
});

test('spotify_play refuses ambiguous or absent matches without sending a playback request', async () => {
    let played = false;
    const duplicate = { ...track, uri: 'spotify:track:def456' };
    const ambiguous = await playSpotify({
        query: 'Hypnotized Purple Disco Machine', type: 'track',
        client: { request: async endpoint => endpoint === '/search' ? { tracks: { items: [track, duplicate] } } : (played = true) },
    });
    assert.equal(ambiguous.error.code, 'spotify_ambiguous_result');
    assert.equal(ambiguous.candidates.length, 2);
    assert.equal(played, false);

    const noResults = await playSpotify({
        query: 'unknown', type: 'track', client: { request: async () => ({ tracks: { items: [] } }) },
    });
    assert.equal(noResults.error.code, 'spotify_no_results');
});

test('spotify_play with an empty query resumes without fabricating a URI', async () => {
    let call;
    const result = await playSpotify({ query: '', type: 'track', client: { request: async (...args) => { call = args; } } });
    assert.equal(result.success, true);
    assert.deepEqual(call, ['/me/player/play', { method: 'PUT' }]);
});

test('device recovery returns a ready device immediately and prefers the active device', async () => {
    const active = { ...recoveredDevice, id: 'active', is_active: true };
    let requests = 0;
    const result = await ensureSpotifyDevice({
        client: { request: async () => { requests += 1; return { devices: [recoveredDevice, active] }; } },
        adapters: recoveryAdapters({ openSpotify: async () => assert.fail('should not launch Spotify') }),
    });
    assert.equal(result.success, true);
    assert.equal(result.device.id, 'active');
    assert.equal(result.recovered, false);
    assert.equal(requests, 1);
});

test('playback launches closed Spotify, retries device discovery, then retries the original track', async () => {
    const calls = [];
    let deviceChecks = 0;
    let launches = 0;
    const result = await playSpotify({
        query: 'Hypnotized Purple Disco Machine',
        client: { request: async (endpoint, options) => {
            calls.push([endpoint, options]);
            if (endpoint === '/search') return { tracks: { items: [track] } };
            if (endpoint === '/me/player/play' && !options?.query) throw spotifyNoDevice();
            if (endpoint === '/me/player/devices') {
                deviceChecks += 1;
                return { devices: deviceChecks === 1 ? [] : [recoveredDevice] };
            }
            return null;
        } },
        recoveryAdapters: recoveryAdapters({
            openSpotify: async () => { launches += 1; return { success: true }; },
        }),
    });
    assert.equal(result.success, true);
    assert.equal(result.recovered, true);
    assert.equal(result.selected.name, 'Hypnotized');
    assert.equal(launches, 1);
    assert.deepEqual(calls.filter(([endpoint]) => endpoint === '/me/player/play').map(([, options]) => options), [
        { method: 'PUT', body: { uris: ['spotify:track:abc123'] } },
        { method: 'PUT', body: { uris: ['spotify:track:abc123'] }, query: { device_id: 'desktop-123' } },
    ]);
});

test('running Spotify is focused and media toggle is skipped while audio is already playing', async () => {
    let toggles = 0;
    let focused = 0;
    let checks = 0;
    const result = await ensureSpotifyDevice({
        client: { request: async endpoint => {
            if (endpoint === '/me/player/devices') return { devices: ++checks === 1 ? [] : [recoveredDevice] };
            if (endpoint === '/me/player/currently-playing') return { is_playing: true, item: track };
            return null;
        } },
        adapters: recoveryAdapters({
            isSpotifyRunning: async () => ({ success: true, running: true }),
            focusSpotify: async () => { focused += 1; return { success: true }; },
            getActiveWindow: async () => ({ success: true, window: { process: 'Spotify.exe' } }),
            playPause: async () => { toggles += 1; },
        }),
    });
    assert.equal(result.success, true);
    assert.equal(focused, 1);
    assert.equal(toggles, 0);
});

test('device recovery reports launch failure, timeout, and ambiguous devices without choosing remotely', async () => {
    const launchFailure = await ensureSpotifyDevice({
        client: { request: async () => ({ devices: [] }) },
        adapters: recoveryAdapters({ openSpotify: async () => ({ success: false, error: { message: 'Launch denied' } }) }),
    });
    assert.equal(launchFailure.error.code, 'spotify_launch_failed');

    const timeout = await ensureSpotifyDevice({
        client: { request: async () => ({ devices: [] }) },
        adapters: recoveryAdapters(),
    });
    assert.equal(timeout.error.code, 'device_timeout');

    const ambiguous = await ensureSpotifyDevice({
        client: { request: async () => ({ devices: [
            { id: 'speaker', name: 'Living room', type: 'speaker', is_active: false },
            { id: 'phone', name: 'Phone', type: 'smartphone', is_active: false },
        ] }) },
        adapters: recoveryAdapters({ openSpotify: async () => assert.fail('should not open for ambiguity') }),
    });
    assert.equal(ambiguous.error.code, 'ambiguous_device');

    const activationFailure = await ensureSpotifyDevice({
        client: { request: async () => ({ devices: [] }) },
        adapters: recoveryAdapters({ isSpotifyRunning: async () => ({ success: false }) }),
    });
    assert.equal(activationFailure.error.code, 'device_activation_failed');
});

test('recovered playback reports playback_failed if Spotify rejects the selected device again', async () => {
    const result = await playSpotify({
        query: 'Hypnotized Purple Disco Machine',
        client: { request: async (endpoint, options) => {
            if (endpoint === '/search') return { tracks: { items: [track] } };
            if (endpoint === '/me/player/play') throw spotifyNoDevice();
            if (endpoint === '/me/player/devices') return { devices: [recoveredDevice] };
            return null;
        } },
        recoveryAdapters: recoveryAdapters(),
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'playback_failed');
});

test('media Play/Pause is used only for a known paused Spotify item in its foreground window', async () => {
    let toggles = 0;
    let checks = 0;
    const result = await ensureSpotifyDevice({
        client: { request: async endpoint => {
            if (endpoint === '/me/player/devices') return { devices: ++checks === 1 ? [] : [recoveredDevice] };
            if (endpoint === '/me/player/currently-playing') return { is_playing: false, item: track };
            return null;
        } },
        adapters: recoveryAdapters({
            isSpotifyRunning: async () => ({ success: true, running: true }),
            getActiveWindow: async () => ({ success: true, window: { process: 'Spotify.exe' } }),
            playPause: async () => { toggles += 1; },
        }),
    });
    assert.equal(result.success, true);
    assert.equal(toggles, 1);
});

test('informational Spotify calls never launch or activate Spotify', async () => {
    let request;
    await searchSpotify('Purple Disco Machine', 'artist', { client: { request: async (...args) => {
        request = args;
        return { artists: { items: [] } };
    } } });
    assert.equal(request[0], '/search');
    assert.equal((await getSpotifyDevices({ client: { request: async () => ({ devices: [] }) } })).success, true);
});

test('pause, next, and previous send their documented methods and require 204 confirmation', async () => {
    const calls = [];
    const client = { request: async (...args) => { calls.push(args); return null; } };
    assert.equal((await pauseSpotify({ client })).confirmed, true);
    assert.equal((await nextSpotifyTrack({ client })).confirmed, true);
    assert.equal((await previousSpotifyTrack({ client })).confirmed, true);
    assert.deepEqual(calls.map(([path, options]) => [path, options.method]), [
        ['/me/player/pause', 'PUT'], ['/me/player/next', 'POST'], ['/me/player/previous', 'POST'],
    ]);
});

test('current track and device list return bounded structured data; no playback is not invented', async () => {
    const current = await getCurrentSpotifyTrack({ client: { request: async () => ({ is_playing: true, progress_ms: 1200, item: track }) } });
    assert.deepEqual(current.track, {
        name: 'Hypnotized', artists: ['Purple Disco Machine'], album: 'Exotica', durationMs: 200000,
        progressMs: 1200, spotifyUrl: 'https://open.spotify.com/track/abc123',
    });
    assert.equal((await getCurrentSpotifyTrack({ client: { request: async () => null } })).track, null);
    const devices = await getSpotifyDevices({ client: { request: async () => ({ devices: [
        { name: 'Laptop', type: 'computer', is_active: true, volume_percent: 45, is_restricted: false, id: 'private-id' },
    ] }) } });
    assert.deepEqual(devices.devices, [{ name: 'Laptop', type: 'computer', active: true, volumePercent: 45, restricted: false }]);
});

test('Spotify access tokens refresh before expiry and retain the prior refresh token if omitted', async () => {
    const saved = [];
    const tokenStore = {
        load: async () => ({ accessToken: 'expired', refreshToken: 'refresh-secret', expiresAt: 1, scope: spotifyScopes }),
        save: async tokens => saved.push(tokens),
    };
    let request;
    const accessToken = await getSpotifyAccessToken({
        environment: { SPOTIFY_CLIENT_ID: 'client-id' },
        tokenStore,
        fetchImpl: async (...args) => {
            request = args;
            return response(200, { access_token: 'fresh', expires_in: 3600 });
        },
        now: () => 10,
    });
    assert.equal(accessToken, 'fresh');
    assert.equal(saved[0].refreshToken, 'refresh-secret');
    assert(request[1].body instanceof URLSearchParams);
    assert.equal(request[1].body.get('grant_type'), 'refresh_token');
});

test('OAuth authorization uses PKCE, a state value, and the fixed configured callback', () => {
    const { url, verifier, state } = createSpotifyAuthorizationUrl({ clientId: 'client-id' });
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://accounts.spotify.com');
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:8888/callback');
    assert.equal(parsed.searchParams.get('state'), state);
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsed.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
    assert.equal(parsed.searchParams.get('client_secret'), null);
});

test('OAuth callback code exchange stores issued tokens locally without a client secret', async () => {
    let form;
    let stored;
    const tokens = await exchangeSpotifyAuthorizationCode({
        code: 'temporary-auth-code', verifier: 'pkce-verifier',
        environment: { SPOTIFY_CLIENT_ID: 'client-id' },
        tokenStore: { save: async value => { stored = value; } },
        fetchImpl: async (_url, options) => {
            form = options.body;
            return response(200, { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: spotifyScopes.join(' ') });
        },
    });
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.equal(form.get('code'), 'temporary-auth-code');
    assert.equal(form.get('code_verifier'), 'pkce-verifier');
    assert.equal(form.get('client_secret'), null);
    assert.equal(stored.refreshToken, 'refresh');
    assert.equal(tokens.accessToken, 'access');
});

test('refresh endpoint saves a rotated refresh token and requires valid configuration', async () => {
    const saved = [];
    await refreshSpotifyTokens({
        refreshToken: 'old-refresh', previous: { refreshToken: 'old-refresh' },
        environment: { SPOTIFY_CLIENT_ID: 'client-id' },
        tokenStore: { save: async value => saved.push(value) },
        fetchImpl: async () => response(200, { access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }),
    });
    assert.equal(saved[0].refreshToken, 'rotated');
});

test('Spotify API maps auth, missing device, permissions, rate limit and network errors', async () => {
    for (const [status, code, headers] of [
        [403, 'spotify_scope_or_premium_required', {}],
        [404, 'spotify_no_device', {}],
        [429, 'spotify_rate_limited', { 'retry-after': '3' }],
    ]) {
        const client = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => response(status, {}, headers) });
        const result = await pauseSpotify({ client });
        assert.equal(result.error.code, code);
    }
    const network = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => { throw new Error('offline'); } });
    assert.equal((await pauseSpotify({ client: network })).error.code, 'spotify_network_error');
});

test('Spotify client refreshes a rejected access token once and retries the same request', async () => {
    const options = [];
    let requests = 0;
    const client = new SpotifyClient({
        getAccessToken: async value => { options.push(value); return value.forceRefresh ? 'new-token' : 'old-token'; },
        fetchImpl: async (_url, init) => {
            requests += 1;
            if (requests === 1) {
                assert.equal(init.headers.Authorization, 'Bearer old-token');
                return response(401, {});
            }
            assert.equal(init.headers.Authorization, 'Bearer new-token');
            return response(200, { ok: true });
        },
    });
    assert.deepEqual(await client.request('/me/player/devices'), { ok: true });
    assert.equal(requests, 2);
    assert.deepEqual(options.map(value => value.forceRefresh === true), [false, true]);
});

test('Spotify outputs are redacted before any follow-up call to the language model', () => {
    const toolResult = { success: true, playing: true, track: { name: 'Private Track', artists: ['Private Artist'], spotifyUrl: track.external_urls.spotify } };
    const modelOutput = spotifyModelSafeOutput('spotify_get_current_track', toolResult);
    assert.equal(JSON.stringify(modelOutput).includes('Private Track'), false);
    assert.equal(JSON.stringify(modelOutput).includes('Private Artist'), false);
    assert.match(formatSpotifyToolResult('spotify_get_current_track', toolResult), /Private Track/u);
    assert.match(formatSpotifyToolResult('spotify_get_current_track', toolResult), /open\.spotify\.com/u);
});

test('Spotify tool registry uses external_read/action permissions and denied tools do not call Spotify', async () => {
    const expected = {
        spotify_get_current_track: 'external_read', spotify_search: 'external_read', spotify_get_devices: 'external_read',
        spotify_play: 'action', spotify_pause: 'action', spotify_next: 'action', spotify_previous: 'action',
    };
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(name => [name, toolPermissions[name]])), expected);
    for (const [name, permission] of Object.entries(expected)) {
        assert.equal(localToolRegistry.get(name).permission, permission);
        assert(getToolsForModel().some(tool => tool.name === name));
    }
    const result = await executeTool('spotify_search', { query: 'Test', type: 'track' }, {
        permissionPolicy: { ...defaultPermissionPolicy, external_read: false },
    });
    assert.equal(result.error.code, 'permission_denied');
    const blockedAction = await executeTool('spotify_pause', {}, {
        permissionPolicy: { ...defaultPermissionPolicy, action: false },
    });
    assert.equal(blockedAction.error.code, 'permission_denied');
});
