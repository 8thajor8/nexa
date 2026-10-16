import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { authorizeSpotify, createSpotifyAuthorizationUrl, exchangeSpotifyAuthorizationCode, getSpotifyAccessToken, refreshSpotifyTokens, spotifyCallbackPage, spotifyScopes } from '../src/integrations/spotify/auth.js';
import { buildSpotifyCallbackPreview } from '../apps/desktop/scripts/spotify-callback-preview.mjs';
import { SpotifyClient } from '../src/integrations/spotify/client.js';
import {
    getCurrentSpotifyTrack,
    getSpotifyDevices,
    formatSpotifyActionOutcome,
    ensureSpotifyDevice,
    nextSpotifyTrack,
    pauseSpotify,
    playSpotify,
    previousSpotifyTrack,
} from '../src/integrations/spotify/playback.js';
import { searchSpotify } from '../src/integrations/spotify/search.js';
import { executeTool, getToolsForModel, localToolRegistry } from '../src/tools/index.js';
import { defaultPermissionPolicy, toolPermissions } from '../src/tools/permissions.js';
import { createSpotifyNowPlayingCard, formatSpotifyToolResult, spotifyModelSafeOutput, spotifyPlayTool } from '../src/tools/spotify.js';

function response(status, payload = null, headers = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        text: async () => payload == null ? '' : JSON.stringify(payload),
        json: async () => payload,
    };
}

const track = {
    name: 'Hypnotized',
    artists: [{ name: 'Purple Disco Machine' }],
    album: { name: 'Exotica', images: [{ url: 'https://i.scdn.co/image/album-cover', width: 640, height: 640 }] },
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
    return Object.assign(new Error('No device'), { code: 'spotify_no_device', status: 404 });
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

test('spotify_play confirms an exact URI only after the requested track is observed playing', async () => {
    const calls = [];
    let statusReads = 0;
    const result = await playSpotify({
        query: 'Hypnotized de Purple Disco Machine',
        type: 'track',
        client: { request: async (...args) => {
            calls.push(args);
            if (args[0] === '/search') return { tracks: { items: [track] } };
            if (args[0] === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (args[0] === '/me/player/currently-playing') {
                statusReads++;
                return statusReads === 1
                    ? { is_playing: false, item: { id: 'track-before', uri: 'spotify:track:old' } }
                    : { is_playing: true, item: { id: 'track-after', uri: 'spotify:track:abc123' } };
            }
            return null;
        } },
        recoveryAdapters: recoveryAdapters(),
    });
    assert.equal(result.success, true);
    assert.equal(result.accepted, true);
    assert.equal(result.stateConfirmed, true);
    assert.equal(result.outcome, 'state_confirmed');
    assert.equal(result.verification, 'target_transition_observed');
    assert.equal(result.selected.name, 'Hypnotized');
    assert.deepEqual(calls.filter(([endpoint]) => !endpoint.endsWith('/currently-playing')).map(([endpoint, options]) => [endpoint, options?.method, options?.body]), [
        ['/search', undefined, undefined],
        ['/me/player/devices', undefined, undefined],
        ['/me/player/play', 'PUT', { uris: ['spotify:track:abc123'] }],
    ]);
});

test('spotify_play falls back once to the provider album context and exact track offset after an unconfirmed URI play', async () => {
    const albumTrack = { ...track, album: { ...track.album, uri: 'spotify:album:album123' } };
    const requests = [];
    const events = [];
    let statusReads = 0;
    const result = await playSpotify({ query: 'Hypnotized de Purple Disco Machine', diagnostic: (event, details) => events.push({ event, details }),
        client: { request: async (endpoint, options = {}) => {
            requests.push([endpoint, options]);
            if (endpoint === '/search') return { tracks: { items: [albumTrack] } };
            if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                if (statusReads <= 4) return { is_playing: false, item: { id: 'old', uri: 'spotify:track:old' }, context: { uri: 'spotify:album:oldalbum' } };
                return { is_playing: true, item: { id: 'abc123', uri: albumTrack.uri }, context: { uri: 'spotify:album:album123' } };
            }
            return null;
        } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, true);
    assert.equal(result.fallbackUsed, true);
    assert.equal(result.selected.name, albumTrack.name);
    assert.match(formatSpotifyToolResult('spotify_play', result), /puede continuar con las pistas siguientes/u);
    const writes = requests.filter(([endpoint]) => endpoint === '/me/player/play');
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.map(([, options]) => options.body), [
        { uris: [albumTrack.uri] },
        { context_uri: 'spotify:album:album123', offset: { uri: albumTrack.uri } },
    ]);
    assert.ok(writes.every(([, options]) => options.query.device_id === recoveredDevice.id));
    assert.equal(events.filter(({ event, details }) => event === 'spotify_track_fallback' && details.stage === 'context_offset_attempt').length, 1);
    assert.equal(events.at(-1).details.outcome, 'state_confirmed');
});

test('spotify_play does not fall back when Spotify search provides no album context', async () => {
    const requests = [];
    let statusReads = 0;
    const result = await playSpotify({ query: 'Hypnotized de Purple Disco Machine',
        client: { request: async (endpoint, options = {}) => {
            requests.push([endpoint, options]);
            if (endpoint === '/search') return { tracks: { items: [track] } };
            if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                return { is_playing: false, item: { id: 'old', uri: 'spotify:track:old' } };
            }
            return null;
        } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, false);
    assert.equal(result.fallbackAttempted, false);
    assert.equal(result.accepted, true);
    assert.equal(requests.filter(([endpoint]) => endpoint === '/me/player/play').length, 1);
});

test('spotify_play reports an unconfirmed fallback rejection without claiming playback', async () => {
    const albumTrack = { ...track, album: { ...track.album, uri: 'spotify:album:album123' } };
    const requests = [];
    let statusReads = 0;
    const result = await playSpotify({ query: 'Hypnotized de Purple Disco Machine',
        client: { request: async (endpoint, options = {}) => {
            requests.push([endpoint, options]);
            if (endpoint === '/search') return { tracks: { items: [albumTrack] } };
            if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                return { is_playing: false, item: { id: 'old', uri: 'spotify:track:old' } };
            }
            if (endpoint === '/me/player/play' && options.body?.offset) {
                throw Object.assign(new Error('synthetic provider rejection'), { code: 'spotify_forbidden', status: 403 });
            }
            return null;
        } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, false);
    assert.equal(result.fallbackAttempted, true);
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.error.code, 'spotify_forbidden');
    assert.equal(requests.filter(([endpoint]) => endpoint === '/me/player/play').length, 2);
});

test('spotify_play keeps an accepted but unobserved album fallback explicitly unconfirmed', async () => {
    const albumTrack = { ...track, album: { ...track.album, uri: 'spotify:album:album123' } };
    let statusReads = 0;
    const result = await playSpotify({ query: 'Hypnotized de Purple Disco Machine',
        client: { request: async endpoint => {
            if (endpoint === '/search') return { tracks: { items: [albumTrack] } };
            if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                return { is_playing: false, item: { id: 'old', uri: 'spotify:track:old' }, context: { uri: 'spotify:album:oldalbum' } };
            }
            return null;
        } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, false);
    assert.equal(result.accepted, true);
    assert.equal(result.fallbackAttempted, true);
    assert.equal(result.outcome, 'provider_accepted_unconfirmed');
    const text = formatSpotifyToolResult('spotify_play', result);
    assert.match(text, /no pude confirmar la reproducción/u);
    assert.doesNotMatch(text, /Spotify está reproduciendo/u);
    assert.match(text, /podría continuar con las pistas siguientes/u);
});

test('Spotify playback diagnostics correlate target, chosen device, and observations without exposing raw identifiers', async () => {
    const events = [];
    let statusReads = 0;
    await playSpotify({
        query: 'Hypnotized Purple Disco Machine',
        diagnostic: (event, details) => events.push({ event, details }),
        requestId: 'synthetic-request',
        client: { request: async (endpoint, options) => {
            if (endpoint === '/search') return { tracks: { items: [track] } };
            if (endpoint === '/me/player/devices') return { devices: [{
                ...recoveredDevice, is_active: true,
            }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                const current = statusReads === 1
                    ? { id: 'previous-track', uri: 'spotify:track:previous' }
                    : { id: track.uri.split(':').at(-1), uri: track.uri };
                return {
                    is_playing: statusReads > 1,
                    item: current,
                    device: { ...recoveredDevice, is_active: true },
                };
            }
            assert.equal(endpoint, '/me/player/play');
            assert.deepEqual(options.query, { device_id: recoveredDevice.id });
            assert.deepEqual(options.body, { uris: [track.uri] });
            return null;
        } },
    });
    const inventory = events.find(entry => entry.event === 'spotify_device_inventory');
    const selected = events.find(entry => entry.event === 'spotify_play_device_selected');
    const request = events.find(entry => entry.event === 'spotify_play_request');
    const after = events.filter(entry => entry.event === 'spotify_playback_observation')
        .find(entry => entry.details.phase === 'after_action');
    assert.equal(inventory.details.deviceCount, 1);
    assert.equal(inventory.details.activeDeviceCount, 1);
    assert.equal(JSON.parse(inventory.details.candidateSummary)[0].fingerprint,
        createHash('sha256').update(recoveredDevice.id).digest('hex').slice(0, 12));
    assert.equal(selected.details.deviceFingerprint, createHash('sha256').update(recoveredDevice.id).digest('hex').slice(0, 12));
    assert.equal(selected.details.deviceActive, true);
    assert.equal(request.details.selectionKind, 'track');
    assert.equal(request.details.deviceIdProvided, true);
    assert.equal(request.details.requestedTrackFingerprint,
        createHash('sha256').update(track.uri).digest('hex').slice(0, 12));
    assert.equal(after.details.trackFingerprint, request.details.requestedTrackFingerprint);
    assert.equal(after.details.deviceFingerprint, selected.details.deviceFingerprint);
    const serialized = JSON.stringify(events);
    for (const privateValue of [track.uri, recoveredDevice.id, recoveredDevice.name, 'spotify:track:previous']) {
        assert.equal(serialized.includes(privateValue), false);
    }
});

test('Spotify search removes duplicate provider URIs without reordering distinct results', async () => {
    const result = await searchSpotify('Parliament', 'track', {
        client: { request: async () => ({ tracks: { items: [track, { ...track }, { ...track, uri: 'spotify:track:other' }] } }) },
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.results.map(item => item.uri), ['spotify:track:abc123', 'spotify:track:other']);
});

test('spotify_play keeps exact matching strict and selects one ranked distinct result for open requests', async () => {
    const nearDuplicate = { ...track, uri: 'spotify:track:duplicate', album: { name: 'Compilation' } };
    const second = { ...track, name: 'Funk Avenue', uri: 'spotify:track:second', artists: [{ name: 'Synthetic Band' }] };
    const calls = [];
    let statusReads = 0;
    const result = await playSpotify({ query: 'funk', type: 'track', selection: 'best_match', client: { request: async (endpoint, options) => {
        calls.push([endpoint, options]);
        if (endpoint === '/search') return { tracks: { items: [track, { ...track }, nearDuplicate, second] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') {
            statusReads++;
            return statusReads === 1 ? { is_playing: false, item: { id: 'old', uri: 'spotify:track:old' } }
                : { is_playing: true, item: { id: 'chosen', uri: 'spotify:track:abc123' } };
        }
        return null;
    } } });
    assert.equal(spotifyPlayTool.parameters.properties.selection.enum.includes('best_match'), true);
    assert.ok(spotifyPlayTool.parameters.required.includes('selection'));
    assert.equal(result.success, true);
    assert.equal(result.selected.name, 'Hypnotized');
    assert.equal(result.verification, 'target_transition_observed');
    assert.deepEqual(calls.filter(([endpoint]) => endpoint === '/me/player/play').map(([, options]) => options.body), [
        { uris: ['spotify:track:abc123'] },
    ]);
});

test('spotify_play matches a spoken exact title and primary artist, ignoring irrelevant search-ranked tracks', async () => {
    const exact = { ...track, name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], uri: 'spotify:track:blinding123' };
    const unrelated = { ...track, name: 'Blinding Lights Remix', artists: [{ name: 'Other Artist' }], uri: 'spotify:track:wrong123' };
    let statusReads = 0;
    const result = await playSpotify({ query: 'Poné Blinding Lights de The Weeknd', client: { request: async endpoint => {
        if (endpoint === '/search') return { tracks: { items: [unrelated, exact] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') return ++statusReads === 1
            ? { is_playing: false, item: { id: 'old', uri: 'spotify:track:old' } }
            : { is_playing: true, item: { id: 'blinding123', uri: exact.uri } };
        return null;
    } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, true);
    assert.equal(result.selected.name, 'Blinding Lights');
    assert.deepEqual(result.selected.artists, ['The Weeknd']);
});

test('spotify_play collapses equivalent remaster entries and prefers the unqualified exact title', async () => {
    const remaster = { ...track, name: 'Blinding Lights - 2019 Remaster', artists: [{ name: 'The Weeknd' }], uri: 'spotify:track:remaster123' };
    const exact = { ...track, name: 'Blinding Lights', artists: [{ name: 'The Weeknd' }], uri: 'spotify:track:standard123' };
    let write;
    const result = await playSpotify({ query: 'Blinding Lights de The Weeknd', client: { request: async (endpoint, options) => {
        if (endpoint === '/search') return { tracks: { items: [remaster, exact] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') return { is_playing: true, item: { id: 'standard123', uri: exact.uri } };
        if (endpoint === '/me/player/play') write = options.body;
        return null;
    } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, true);
    assert.equal(result.selected.name, 'Blinding Lights');
    assert.deepEqual(write, { uris: [exact.uri] });
});

test('spotify_play asks for clarification when the exact title has genuinely different primary artists', async () => {
    const first = { ...track, name: 'Halo', artists: [{ name: 'Beyoncé' }], uri: 'spotify:track:halo1' };
    const second = { ...track, name: 'Halo', artists: [{ name: 'Other Artist' }], uri: 'spotify:track:halo2' };
    let writes = 0;
    const result = await playSpotify({ query: 'Halo', client: { request: async endpoint => {
        if (endpoint === '/search') return { tracks: { items: [first, second] } };
        if (endpoint === '/me/player/play') writes++;
        return null;
    } } });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'spotify_ambiguous_result');
    assert.equal(result.candidates.length, 2);
    assert.equal(writes, 0);
});

test('spotify_play reproduces accepted track request followed by HTTP 200 with no current item', async () => {
    let statusReads = 0;
    let playRequest;
    const diagnostics = [];
    const requestedTrack = { ...track, name: 'Weightless', artists: [{ name: 'Marconi Union' }],
        uri: 'spotify:track:weightless' };
    const result = await playSpotify({
        query: 'Weightless Marconi Union',
        diagnostic: (event, details) => diagnostics.push({ event, details }),
        client: { request: async (endpoint, options) => {
            if (endpoint === '/search') return { tracks: { items: [requestedTrack] } };
            if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                return { is_playing: false, item: null, device: null };
            }
            if (endpoint === '/me/player/play') {
                playRequest = options;
                return null; // The Web API's documented 204 response.
            }
            return null;
        } },
    });
    assert.equal(result.success, false);
    assert.equal(result.accepted, true);
    assert.equal(result.stateConfirmed, false);
    assert.equal(result.verification, 'target_not_observed');
    assert.equal(playRequest.query.device_id, recoveredDevice.id);
    assert.deepEqual(playRequest.body, { uris: [requestedTrack.uri] });
    assert.equal(statusReads, 4);
    const after = diagnostics.filter(entry => entry.event === 'spotify_playback_observation'
        && entry.details.phase === 'after_action');
    assert.equal(after.length, 3);
    assert.ok(after.every(entry => entry.details.playbackState === 'no_current_item'
        && entry.details.deviceActive === false && entry.details.deviceFingerprint === null));
});

test('spotify_play reports provider acceptance without claiming playback when the requested track is not observed', async () => {
    let statusReads = 0;
    let writes = 0;
    const result = await playSpotify({ query: 'Hypnotized Purple Disco Machine', type: 'track', client: { request: async endpoint => {
        if (endpoint === '/search') return { tracks: { items: [track] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') {
            statusReads++;
            return { is_playing: false, item: { id: 'other', uri: 'spotify:track:other' } };
        }
        writes++;
        return null;
    } } });
    assert.equal(result.success, false);
    assert.equal(result.accepted, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.stateConfirmed, false);
    assert.equal(result.outcome, 'provider_accepted_unconfirmed');
    assert.equal(result.error.code, 'spotify_playback_unconfirmed');
    assert.equal(writes, 1);
    assert.ok(statusReads >= 2);
    const message = formatSpotifyToolResult('spotify_play', result);
    assert.match(message, /aceptó la solicitud/u);
    assert.match(message, /no pude confirmar la reproducción/u);
    assert.doesNotMatch(message, /Spotify está reproduciendo/u);
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

test('spotify_play resumes an existing paused Spotify session and confirms the resulting state', async () => {
    let call;
    let statusReads = 0;
    const result = await playSpotify({ query: '', type: 'track', client: { request: async (...args) => {
        if (args[0] === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (args[0] === '/me/player/currently-playing') {
            statusReads++;
            return statusReads === 1
                ? { is_playing: false, item: { id: 'existing', uri: 'spotify:track:existing' } }
                : { is_playing: true, item: { id: 'existing', uri: 'spotify:track:existing' } };
        }
        call = args;
    } }, recoveryAdapters: recoveryAdapters() });
    assert.equal(result.success, true);
    assert.equal(result.stateConfirmed, true);
    assert.equal(result.verification, 'target_transition_observed');
    assert.deepEqual(call, ['/me/player/play', { method: 'PUT', responseContract: 'no-content', query: { device_id: 'desktop-123' } }]);
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

test('playback resolves a device before one play command rather than retrying a rejected write', async () => {
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
            if (endpoint === '/me/player/currently-playing') return { is_playing: true, item: { id: 'target', uri: 'spotify:track:abc123' } };
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
        { method: 'PUT', responseContract: 'no-content', body: { uris: ['spotify:track:abc123'] }, query: { device_id: 'desktop-123' } },
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

test('playback does not retry a write after Spotify rejects the selected device with 404', async () => {
    let writes = 0;
    const result = await playSpotify({
        query: 'Hypnotized Purple Disco Machine',
        client: { request: async (endpoint, options) => {
            if (endpoint === '/search') return { tracks: { items: [track] } };
            if (endpoint === '/me/player/devices') return { devices: [recoveredDevice] };
            if (endpoint === '/me/player/play') { writes++; throw spotifyNoDevice(); }
            return null;
        } },
        recoveryAdapters: recoveryAdapters(),
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'spotify_no_device');
    assert.equal(result.outcome, 'rejected');
    assert.equal(writes, 1);
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

test('pause, next, and previous send their documented methods and accept bodyless success', async () => {
    const calls = [];
    const client = { request: async (...args) => { calls.push(args); return null; } };
    assert.equal((await pauseSpotify({ client })).confirmed, true);
    assert.equal((await nextSpotifyTrack({ client })).confirmed, true);
    assert.equal((await previousSpotifyTrack({ client })).confirmed, true);
    assert.deepEqual(calls.filter(([path]) => path !== '/me/player/currently-playing').map(([path, options]) => [path, options.method]), [
        ['/me/player/pause', 'PUT'], ['/me/player/next', 'POST'], ['/me/player/previous', 'POST'],
    ]);
});

test('current track and device list return bounded structured data; no playback is not invented', async () => {
    const current = await getCurrentSpotifyTrack({ client: { request: async () => ({ is_playing: true, progress_ms: 1200, item: track }) } });
    assert.deepEqual(current.track, {
        name: 'Hypnotized', artists: ['Purple Disco Machine'], album: 'Exotica', durationMs: 200000,
        progressMs: 1200, spotifyUrl: 'https://open.spotify.com/track/abc123', imageUrl: 'https://i.scdn.co/image/album-cover',
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

test('Spotify accepts documented 204 playback responses and treats other 2xx write responses as uncertain', async () => {
    for (const status of [200, 202]) {
        const client = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => response(status) });
        const result = await nextSpotifyTrack({ client });
        assert.equal(result.success, false, `status ${status}`);
        assert.equal(result.outcome, 'uncertain');
        assert.equal(result.error.code, 'spotify_action_outcome_uncertain');
    }
    const documented = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => response(204) });
    const accepted = await nextSpotifyTrack({ client: documented });
    assert.equal(accepted.success, true);
    assert.equal(accepted.outcome, 'provider_accepted');
    assert.equal(accepted.postStateConfirmed, false);
    assert.equal(accepted.confirmed, true);
    const jsonRead = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => response(200, { accepted: true }) });
    assert.deepEqual(await jsonRead.request('/me/player', { method: 'GET' }), { accepted: true });
});

test('Spotify playback enforces no-content writes and never logs unexpected response bodies', async () => {
    const successfulClient = new SpotifyClient({
        getAccessToken: async () => 'test-token',
        fetchImpl: async input => {
            const path = new URL(input).pathname;
            if (path.endsWith('/devices')) return response(200, { devices: [{ ...recoveredDevice, is_active: true }] });
            if (path.endsWith('/currently-playing')) return response(200, { is_playing: true, item: track });
            return response(204);
        },
    });
    for (const [tool, args] of [
        ['spotify_play', { query: '', type: 'track' }], ['spotify_pause', {}],
        ['spotify_next', {}], ['spotify_previous', {}],
    ]) {
        const result = await executeTool(tool, args, { client: successfulClient });
        assert.equal(result.success, true, tool);
        assert.equal(result.outcome, tool === 'spotify_play' ? 'state_confirmed' : 'provider_accepted', tool);
    }

    const events = [];
    const invalidClient = new SpotifyClient({
        getAccessToken: async () => 'test-token',
        fetchImpl: async input => new URL(input).pathname.endsWith('/devices')
            ? response(200, { devices: [{ ...recoveredDevice, is_active: true }] })
            : new URL(input).pathname.endsWith('/currently-playing') ? response(200, { is_playing: true, item: track })
                : ({ status: 200, ok: true, headers: { get: () => null }, text: async () => 'provider-private-body',
                    body: { cancel: async () => {} } }),
    });
    const invalid = await nextSpotifyTrack({ client: invalidClient,
        diagnostic: (event, details) => events.push({ event, details }) });
    assert.equal(invalid.success, false);
    assert.equal(invalid.error.code, 'spotify_action_outcome_uncertain');
    assert.equal(invalid.outcome, 'uncertain');
    assert.deepEqual(events.map(entry => entry.event), ['spotify_playback_observation', 'spotify_provider_response',
        'spotify_response_body', 'spotify_playback_observation', 'spotify_action_result']);
    assert.equal(events[2].details.bodyKind, 'not_read');
    assert.equal(events[2].details.bodyLength, null);
    assert.equal(events[2].details.contentType, 'missing');
    assert.equal(JSON.stringify(events).includes('provider-private-body'), false);
});

test('Spotify 200 with undocumented 27-character body and no Content-Type is uncertain and is never retried', async () => {
    const body = 'x'.repeat(27); // Synthetic opaque body; it is not the physical response content.
    assert.equal(body.length, 27);
    let calls = 0;
    let writes = 0;
    const events = [];
    const requests = [];
    const client = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async (input, init) => {
        calls++;
        requests.push([input, init]);
        if (new URL(input).pathname.endsWith('/currently-playing')) {
            return response(200, { is_playing: true, item: { id: 'track-before' } });
        }
        writes++;
        return { status: 200, ok: true, url: 'https://api.spotify.com/v1/me/player/next', redirected: false, type: 'basic',
            headers: { get: () => null }, text: async () => body };
    } });
    const result = await nextSpotifyTrack({ client, diagnostic: (event, details) => events.push({ event, details }) });
    assert.equal(writes, 1);
    assert.equal(calls, 5); // pre-read, one write, and bounded state-only reconciliation reads.
    assert.equal(requests[1][0].href, 'https://api.spotify.com/v1/me/player/next');
    assert.equal(requests[1][1].method, 'POST');
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.error.code, 'spotify_action_outcome_uncertain');
    assert.equal(result.verification, 'unchanged');
    assert.equal(events.find(({ event }) => event === 'spotify_response_body').details.bodyLength, null);
    assert.equal(events.find(({ event }) => event === 'spotify_response_body').details.bodyKind, 'not_read');
    assert.equal(events.find(({ event }) => event === 'spotify_response_body').details.contentType, 'missing');
    assert.equal(events.find(({ event }) => event === 'spotify_provider_response').details.requestHost, 'api.spotify.com');
    assert.equal(events.find(({ event }) => event === 'spotify_provider_response').details.requestPath, '/v1/me/player/next');
    assert.equal(events.find(({ event }) => event === 'spotify_provider_response').details.responseHost, 'api.spotify.com');
    assert.equal(events.find(({ event }) => event === 'spotify_provider_response').details.redirected, false);
    assert.equal(JSON.stringify(events).includes(body), false);
});

test('Spotify undocumented 200 playback response is not read, logged, accepted, or retried', async () => {
    let bodyReads = 0;
    let bodyCancels = 0;
    let requests = 0;
    const events = [];
    const bodyText = 'Synthetic response fixture only';
    const client = new SpotifyClient({
        getAccessToken: async () => 'synthetic-token',
        fetchImpl: async input => {
            requests++;
            return { status: 200, ok: true, url: String(input), redirected: false, type: 'basic',
                headers: { get: () => null }, text: async () => { bodyReads++; return bodyText; },
                body: { cancel: async () => { bodyCancels++; } } };
        },
    });
    await assert.rejects(client.request('/me/player/next', { method: 'POST', responseContract: 'no-content',
        onResponse: (status, details) => events.push({ status, details }) }),
    error => error.code === 'spotify_unexpected_write_response' && error.status === 200);
    assert.equal(requests, 1);
    assert.equal(bodyReads, 0);
    assert.equal(bodyCancels, 1);
    const bodyEvent = events.find(event => event.details.stage === 'response_body');
    assert.equal(bodyEvent.details.bodyKind, 'not_read');
    assert.equal(bodyEvent.details.bodyLength, null);
    assert.equal(bodyEvent.details.contentType, 'missing');
    assert.equal(JSON.stringify(events).includes(bodyText), false);
});

// Historical detector audit using synthetic text only: an innocent long word
// matched the opaque-string pattern, so its former rejection was not evidence
// that the physical response contained a credential.
test('historical opaque-string detector false-positive example is synthetic', () => {
    const formerOpaquePattern = /(?:[A-Za-z0-9_-]{20,}|\b[0-9a-f]{16,}\b)/iu;
    assert.equal(formerOpaquePattern.test('thisisjustaharmlesslongword'), true);
    assert.equal(formerOpaquePattern.test('short plain text'), false);
});

test('Spotify playback write does not replay the action after a 401 response', async () => {
    let requests = 0;
    let tokenRequests = 0;
    const client = new SpotifyClient({
        getAccessToken: async () => { tokenRequests++; return 'synthetic-token'; },
        fetchImpl: async () => { requests++; return response(401, { error: 'unauthorized' }); },
    });
    await assert.rejects(client.request('/me/player/next', { method: 'POST', responseContract: 'no-content' }),
        error => error.code === 'spotify_auth_expired' && error.status === 401);
    assert.equal(requests, 1);
    assert.equal(tokenRequests, 1);
});

test('Spotify anomalous playback writes confirm only verified play/pause intent and previous-track restart', async () => {
    const scenarios = [
        { action: 'pause', before: { is_playing: true, item: { id: 'track-a' } }, after: { is_playing: false, item: { id: 'track-a' } }, expected: 'target_transition_observed', outcome: 'state_confirmed' },
        { action: 'pause', before: { is_playing: false, item: { id: 'track-a' } }, after: { is_playing: false, item: { id: 'track-a' } }, expected: 'target_already_observed', outcome: 'state_confirmed' },
        { action: 'play', before: { is_playing: false, item: { id: 'track-a' } }, after: { is_playing: true, item: { id: 'track-a' } }, expected: 'target_transition_observed', outcome: 'state_confirmed' },
        { action: 'play', before: { is_playing: true, item: { id: 'track-a' } }, after: { is_playing: true, item: { id: 'track-a' } }, expected: 'target_already_observed', outcome: 'state_confirmed' },
        { action: 'play', before: null, after: { is_playing: true, item: { id: 'track-a' } }, expected: 'target_state_observed' },
        { action: 'play', before: null, after: null, expected: 'unavailable' },
        { action: 'next', before: { is_playing: true, item: { id: 'track-a' } }, after: { is_playing: true, item: { id: 'track-b' } }, expected: 'track_changed_observed' },
        { action: 'previous', before: { is_playing: true, item: { id: 'track-b' } }, after: { is_playing: true, item: { id: 'track-a' } }, expected: 'track_changed_observed' },
        { action: 'next', before: { is_playing: true, item: { id: 'track-a' } }, after: { is_playing: true, item: { id: 'track-a' } }, expected: 'unchanged' },
        { action: 'next', before: { is_playing: true, item: { id: 'track-a' } }, after: null, expected: 'unavailable' },
        { action: 'previous', before: { is_playing: true, progress_ms: 15_000, item: { id: 'track-a' } },
            after: { is_playing: true, progress_ms: 1_000, item: { id: 'track-a' } },
            expected: 'previous_track_restarted_observed', outcome: 'state_confirmed' },
    ];
    for (const scenario of scenarios) {
        let statusReads = 0;
        let writes = 0;
        const client = { request: async (endpoint, options = {}) => {
            if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
            if (endpoint === '/me/player/currently-playing') {
                statusReads++;
                if (statusReads === 1) return scenario.before;
                if (!scenario.after) throw new Error('synthetic status unavailable');
                return scenario.after;
            }
            writes++;
            throw Object.assign(new Error('synthetic undocumented response'), { code: 'spotify_unexpected_write_response', status: 200 });
        } };
        const result = scenario.action === 'pause' ? await pauseSpotify({ client })
            : scenario.action === 'play' ? await playSpotify({ client })
                : scenario.action === 'previous' ? await previousSpotifyTrack({ client }) : await nextSpotifyTrack({ client });
        const expectedOutcome = scenario.outcome ?? 'uncertain';
        assert.equal(result.success, expectedOutcome === 'state_confirmed', scenario.action);
        assert.equal(result.outcome, expectedOutcome, scenario.action);
        assert.equal(result.verification, scenario.expected, scenario.action);
        assert.equal(writes, 1, scenario.action);
        assert.equal(result.accepted, expectedOutcome === 'state_confirmed' ? false : undefined, scenario.action);
        assert.equal(result.stateConfirmed, expectedOutcome === 'state_confirmed' ? true : undefined, scenario.action);
        if (scenario.action === 'pause' && scenario.expected === 'target_transition_observed') {
            assert.equal(formatSpotifyActionOutcome('pause', 'state_confirmed', result.verification), 'Spotify pausado');
        }
        if (scenario.expected === 'target_state_observed') {
            assert.equal(formatSpotifyActionOutcome('play', result.outcome, result.verification),
                'Spotify está reproduciendo');
        }
        if (scenario.expected === 'track_changed_observed') {
            assert.equal(formatSpotifyActionOutcome(scenario.action, result.outcome, result.verification),
                'Canción cambiada');
        }
    }
    assert.equal(formatSpotifyActionOutcome('previous', 'state_confirmed', 'previous_track_restarted_observed'), 'Canción reiniciada');
});

test('Spotify HTTP 200 playback anomaly can confirm a pause from a synthetic before/after state transition', async () => {
    const calls = [];
    let statusReads = 0;
    let bodyReads = 0;
    let bodyCancels = 0;
    const client = new SpotifyClient({ getAccessToken: async () => 'synthetic-token', fetchImpl: async (input, init) => {
        const url = new URL(input);
        calls.push({ path: url.pathname, method: init.method });
        if (url.pathname.endsWith('/currently-playing')) {
            statusReads++;
            const playing = statusReads === 1;
            return { ...response(200, { is_playing: playing, progress_ms: playing ? 8_000 : 7_900,
                item: { id: 'track-a', uri: 'spotify:track:a' } }),
                url: String(input), redirected: false, type: 'basic' };
        }
        return { status: 200, ok: true, url: String(input), redirected: false, type: 'basic',
            headers: { get: () => null }, text: async () => { bodyReads++; return 'Synthetic response only'; },
            body: { cancel: async () => { bodyCancels++; } } };
    } });
    const result = await pauseSpotify({ client });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'state_confirmed');
    assert.equal(result.accepted, false);
    assert.equal(result.stateConfirmed, true);
    assert.equal(result.verification, 'target_transition_observed');
    assert.deepEqual(result.verificationEvidence, { before: { playing: true, trackAvailable: true },
        after: { playing: false, trackAvailable: true }, trackChanged: false,
        requestedTargetMatched: null, previousTrackRestartObserved: false, verification: 'target_transition_observed' });
    assert.equal(bodyReads, 0);
    assert.equal(bodyCancels, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/pause')).length, 1);
});

test('Spotify play of a selected track is not state-confirmed when playback remains on another track', async () => {
    let writes = 0;
    const client = { request: async (endpoint, options = {}) => {
        if (endpoint === '/search') return { tracks: { items: [track] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') return { is_playing: true, item: { id: 'other', uri: 'spotify:track:other' } };
        writes++;
        throw Object.assign(new Error('synthetic undocumented response'), { code: 'spotify_unexpected_write_response', status: 200 });
    } };
    const result = await playSpotify({ query: 'Hypnotized Purple Disco Machine', type: 'track', client });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.verification, 'target_not_observed');
    assert.equal(result.verificationEvidence.requestedTargetMatched, false);
    assert.equal(writes, 1);
});

test('Spotify play of a selected track is state-confirmed when the observed track matches the request', async () => {
    let statusReads = 0;
    const client = { request: async (endpoint, options = {}) => {
        if (endpoint === '/search') return { tracks: { items: [track] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') {
            statusReads++;
            return { is_playing: true, item: { id: 'track-a', uri: 'spotify:track:abc123' } };
        }
        throw Object.assign(new Error('synthetic undocumented response'), { code: 'spotify_unexpected_write_response', status: 200 });
    } };
    const result = await playSpotify({ query: 'Hypnotized Purple Disco Machine', type: 'track', client });
    assert.equal(result.success, true);
    assert.equal(result.outcome, 'state_confirmed');
    assert.equal(result.verification, 'target_already_observed');
    assert.equal(result.verificationEvidence.requestedTargetMatched, true);
    assert.equal(statusReads, 2);
    assert.match(formatSpotifyToolResult('spotify_play', result), /Spotify está reproduciendo: \*\*Hypnotized\*\*/u);
});

test('Spotify reports observed playback without claiming causality when the before state is unknown', async () => {
    let reads = 0;
    const client = { request: async (endpoint, options = {}) => {
        if (endpoint === '/search') return { tracks: { items: [track] } };
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') {
            reads++;
            return reads === 1 ? null : { is_playing: true, item: { id: 'track-a', uri: 'spotify:track:abc123' } };
        }
        throw Object.assign(new Error('synthetic undocumented response'), { code: 'spotify_unexpected_write_response', status: 200 });
    } };
    const result = await playSpotify({ query: 'Hypnotized Purple Disco Machine', type: 'track', client });
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.verification, 'target_state_observed');
    assert.equal(result.verificationEvidence.before, null);
    assert.equal(result.verificationEvidence.after.playing, true);
    assert.equal(result.verificationEvidence.requestedTargetMatched, true);
    assert.equal(formatSpotifyToolResult('spotify_play', result),
        'Spotify está reproduciendo');
});

test('first Play traces an unknown startup state without reading response bodies or repeating the write', async () => {
    const entries = [];
    let writes = 0;
    let statusReads = 0;
    const client = { request: async (endpoint, options = {}) => {
        if (endpoint === '/me/player/devices') {
            options.onResponse?.(200);
            return { devices: [{ ...recoveredDevice, is_active: true }] };
        }
        if (endpoint === '/me/player/currently-playing') {
            statusReads++;
            options.onResponse?.(statusReads === 1 ? 204 : 200);
            return statusReads === 1 ? null : { is_playing: true, item: { id: 'track-a' } };
        }
        writes++;
        throw Object.assign(new Error('synthetic undocumented response'), { code: 'spotify_unexpected_write_response', status: 200 });
    } };
    const result = await playSpotify({ client, diagnostic: (event, details) => entries.push({ event, details }),
        requestId: 'first-play-startup' });
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.verification, 'target_state_observed');
    assert.equal(writes, 1);
    assert.ok(entries.some(({ event, details }) => event === 'spotify_playback_observation'
        && details.phase === 'before_action' && details.known === false
        && details.reason === 'empty_or_no_active_playback' && details.httpStatus === 204));
    assert.equal(JSON.stringify(entries).includes('synthetic undocumented response'), false);
});

test('first Play reports an HTTP 403 from device discovery as a provider rejection with no playback write', async () => {
    const entries = [];
    let writes = 0;
    const client = { request: async (endpoint, options = {}) => {
        if (endpoint === '/me/player/devices') {
            options.onResponse?.(403);
            throw Object.assign(new Error('provider rejection'), { code: 'spotify_forbidden', status: 403 });
        }
        writes++;
        return null;
    } };
    const result = await playSpotify({ client, diagnostic: (event, details) => entries.push({ event, details }),
        requestId: 'first-play-forbidden' });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'spotify_forbidden');
    assert.equal(result.status, 403);
    assert.equal(result.error.message, 'Spotify rechazó la acción (HTTP 403); puede deberse a permisos, cuenta o una restricción del proveedor.');
    assert.equal(writes, 0);
    assert.ok(entries.some(({ event, details }) => event === 'spotify_play_preflight'
        && details.stage === 'device_discovery' && details.httpStatus === 403));
});

test('Spotify state reconciliation handles eventual consistency with read-only polls', async () => {
    let reads = 0;
    let writes = 0;
    const client = { request: async endpoint => {
        if (endpoint === '/me/player/currently-playing') {
            reads++;
            return { is_playing: true, item: { id: reads >= 3 ? 'track-b' : 'track-a' } };
        }
        writes++;
        throw Object.assign(new Error('synthetic undocumented response'), { code: 'spotify_unexpected_write_response', status: 200 });
    } };
    const result = await nextSpotifyTrack({ client });
    assert.equal(result.verification, 'track_changed_observed');
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(writes, 1);
    assert.equal(reads, 3);
});

test('Spotify model output carries a safe state-confirmed message without asserting provider acceptance', () => {
    const output = spotifyModelSafeOutput('spotify_pause', { success: true, action: 'pause', accepted: false,
        confirmed: true, stateConfirmed: true, postStateConfirmed: true, outcome: 'state_confirmed', verification: 'target_transition_observed' });
    assert.deepEqual(output, { success: true, accepted: false, stateConfirmed: true, outcome: 'state_confirmed',
        postStateConfirmed: true, action: 'pause', confirmation: 'Spotify pausado' });
});

test('Spotify model output preserves acceptance separately from unconfirmed playback', () => {
    assert.deepEqual(spotifyModelSafeOutput('spotify_play', { success: false, accepted: true,
        stateConfirmed: false, outcome: 'provider_accepted_unconfirmed', error: { code: 'spotify_playback_unconfirmed' } }), {
        success: false, accepted: true, stateConfirmed: false, outcome: 'provider_accepted_unconfirmed',
        error: { code: 'spotify_playback_unconfirmed' },
    });
});

test('Runtime dispatcher preserves accepted empty Spotify playback responses for every control', async () => {
    const calls = [];
    let statusReads = 0;
    const client = { request: async (endpoint, options) => { calls.push({ endpoint, options });
        if (endpoint === '/me/player/devices') return { devices: [{ ...recoveredDevice, is_active: true }] };
        if (endpoint === '/me/player/currently-playing') {
            statusReads++;
            return statusReads <= 2
                ? { is_playing: false, item: { id: 'existing', uri: 'spotify:track:existing' } }
                : { is_playing: true, item: { id: 'existing', uri: 'spotify:track:existing' } };
        }
        return null;
    } };
    for (const [name, args] of [
        ['spotify_next', {}], ['spotify_previous', {}], ['spotify_pause', {}], ['spotify_play', { query: '', type: 'track' }],
    ]) {
        const result = await executeTool(name, args, { client });
        assert.equal(result.success, true, name);
        assert.equal(result.accepted, true, name);
        assert.equal(result.outcome, name === 'spotify_play' ? 'state_confirmed' : 'provider_accepted', name);
        assert.equal(result.postStateConfirmed, name === 'spotify_play', name);
    }
    assert.deepEqual(calls.map(call => call.endpoint), [
        '/me/player/currently-playing', '/me/player/next', '/me/player/currently-playing',
        '/me/player/previous', '/me/player/currently-playing',
        '/me/player/pause',
        '/me/player/devices', '/me/player/currently-playing', '/me/player/play', '/me/player/currently-playing',
    ]);
});

test('Spotify playback diagnostics correlate provider status and normalized outcome without secrets', async () => {
    const entries = [];
    const client = { request: async (_endpoint, options) => { options.onResponse(204); return null; } };
    const result = await nextSpotifyTrack({ client, requestId: 'spotify-call-1',
        diagnostic: (event, details) => entries.push({ event, details }) });
    assert.equal(result.success, true);
    assert.deepEqual(entries.map(({ event }) => event), ['spotify_playback_observation', 'spotify_provider_response', 'spotify_action_result']);
    assert.equal(entries[0].details.requestId, 'spotify-call-1');
    assert.equal(entries[0].details.phase, 'before_action');
    assert.equal(entries[1].details.httpStatus, 204);
    assert.equal(entries[1].details.requestId, 'spotify-call-1');
    assert.equal(entries[2].details.outcome, 'provider_accepted');
    assert.equal(JSON.stringify(entries).includes('Bearer'), false);
});

test('Spotify does not retry an uncertain track skip after a transport failure', async () => {
    const writes = [];
    const client = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async input => {
        const url = new URL(input);
        if (url.pathname.endsWith('/currently-playing')) throw new Error('synthetic read timeout');
        writes.push(url.pathname);
        throw new Error('synthetic write timeout');
    } });
    const result = await nextSpotifyTrack({ client });
    assert.deepEqual(writes, ['/v1/me/player/next']);
    assert.equal(result.success, false);
    assert.equal(result.outcome, 'uncertain');
    assert.equal(result.error.code, 'spotify_action_outcome_uncertain');
    assert.match(formatSpotifyToolResult('spotify_next', result), /No la repetí automáticamente/u);
});

test('Spotify preserves confirmed 401, 403, 404 and 429 write rejections', async () => {
    for (const status of [401, 403, 404, 429]) {
        let writes = 0;
        const client = { request: async endpoint => {
            if (endpoint === '/me/player/currently-playing') return { is_playing: true, item: { id: 'track-a' } };
            writes++;
            throw Object.assign(new Error('synthetic provider rejection'), { code: `http_${status}`, status });
        } };
        const result = await nextSpotifyTrack({ client });
        assert.equal(result.outcome, 'rejected', `HTTP ${status}`);
        assert.equal(writes, 1, `HTTP ${status} action count`);
    }
});

test('Spotify distinguishes service failure from uncertain write response', async () => {
    const unavailableClient = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => response(503, {}) });
    assert.equal((await previousSpotifyTrack({ client: unavailableClient })).outcome, 'uncertain');
});

test('Desktop OAuth adapter opens the system browser and completes only through the local PKCE callback', async () => {
    let authorizationUrl;
    let saved;
    let releaseBrowserOpened;
    const browserOpened = new Promise(resolve => { releaseBrowserOpened = resolve; });
    const authorization = authorizeSpotify({
        environment: { SPOTIFY_CLIENT_ID: 'client-id' },
        output: () => assert.fail('Desktop authorization must not print a link to the terminal.'),
        browserOpener: async url => { authorizationUrl = url; releaseBrowserOpened(); },
        tokenStore: { save: async tokens => { saved = tokens; } },
        fetchImpl: async (_url, options) => {
            assert.equal(options.body.get('grant_type'), 'authorization_code');
            assert.equal(options.body.get('client_secret'), null);
            return response(200, { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh',
                expires_in: 3600, scope: spotifyScopes.join(' ') });
        },
    });
    await browserOpened;
    const parsed = new URL(authorizationUrl);
    assert.equal(parsed.origin, 'https://accounts.spotify.com');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsed.searchParams.get('client_secret'), null);
    const callback = new URL('http://127.0.0.1:8888/callback');
    callback.searchParams.set('state', parsed.searchParams.get('state'));
    callback.searchParams.set('code', 'synthetic-code');
    const callbackResponse = await fetch(callback);
    assert.equal(callbackResponse.status, 200);
    assert.match(callbackResponse.headers.get('content-type'), /text\/html/u);
    assert.equal(callbackResponse.headers.get('cache-control'), 'no-store');
    const callbackHtml = await callbackResponse.text();
    assert.match(callbackHtml, /Spotify conectado/u);
    assert.match(callbackHtml, /Volvé a Nexa/u);
    assert.match(callbackHtml, /Content-Security-Policy/u);
    assert.equal(callbackHtml.includes('synthetic-code'), false);
    assert.equal(callbackHtml.includes('synthetic-access'), false);
    const tokens = await authorization;
    assert.equal(tokens.accessToken, 'synthetic-access');
    assert.equal(saved.refreshToken, 'synthetic-refresh');
});

test('Spotify callback pages are branded for success, cancellation, and failure without reflecting OAuth data', () => {
    for (const [status, text] of [['success', 'Spotify conectado'], ['cancelled', 'Conexión cancelada'], ['failed', 'No se pudo conectar']]) {
        const html = spotifyCallbackPage(status);
        assert.match(html, /color-scheme:dark/u);
        assert.match(html, /Content-Security-Policy/u);
        assert.match(html, new RegExp(text, 'u'));
        assert.equal(/access_token|refresh_token|authorization_code|client_secret|code_verifier/iu.test(html), false);
    }
});

test('development callback preview uses all three real static callback designs without starting OAuth', () => {
    const preview = buildSpotifyCallbackPreview(spotifyCallbackPage);
    assert.match(preview, /Vista previa de callback Spotify \(sin autorización real\)/u);
    assert.match(preview, /Callback Spotify: Éxito/u);
    assert.match(preview, /Callback Spotify: Cancelación/u);
    assert.match(preview, /Callback Spotify: Error/u);
    assert.match(preview, /spotifyCallbackPage|srcdoc=/u);
    assert.doesNotMatch(preview, /access_token|refresh_token|client_secret|accounts\.spotify\.com\/authorize/u);
});

test('Now Playing card contains only bounded Spotify metadata from trusted URLs', async () => {
    const card = createSpotifyNowPlayingCard({ success: true, playing: true, track: {
        name: ' Track\nName ', artists: ['Artist\u0000 One', ''], imageUrl: 'https://i.scdn.co/image/abc',
        spotifyUrl: 'https://open.spotify.com/track/abc123?si=tracking',
    } });
    assert.deepEqual(card, { name: 'TrackName', artists: ['Artist One'], imageUrl: 'https://i.scdn.co/image/abc',
        spotifyUrl: 'https://open.spotify.com/track/abc123', playing: true });
    assert.equal(createSpotifyNowPlayingCard({ success: true, track: { name: 'Track', imageUrl: 'https://attacker.test/x' } }).imageUrl, null);
    assert.equal(createSpotifyNowPlayingCard({ success: true, track: { name: '', artists: ['Artist'] } }), null);
    assert.equal(createSpotifyNowPlayingCard({ success: false, track: { name: 'Track' } }), null);
});

test('Desktop Spotify authorization honors cancellation before opening a browser', async () => {
    const controller = new AbortController();
    controller.abort();
    let opened = false;
    await assert.rejects(authorizeSpotify({
        environment: { SPOTIFY_CLIENT_ID: 'client-id' }, signal: controller.signal,
        browserOpener: async () => { opened = true; },
        fetchImpl: async () => assert.fail('A cancelled authorization must not exchange tokens.'),
        tokenStore: { save: async () => assert.fail('A cancelled authorization must not store tokens.') },
    }), error => error.code === 'spotify_authorization_cancelled');
    assert.equal(opened, false);
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

test('Spotify API maps auth, missing device, provider rejection, rate limit and network errors', async () => {
    for (const [status, code, headers] of [
        [403, 'spotify_forbidden', {}],
        [404, 'spotify_no_device', {}],
        [429, 'spotify_rate_limited', { 'retry-after': '3' }],
    ]) {
        const client = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => response(status, {}, headers) });
        const result = await pauseSpotify({ client });
        assert.equal(result.error.code, code);
    }
    const network = new SpotifyClient({ getAccessToken: async () => 'test-token', fetchImpl: async () => { throw new Error('offline'); } });
    const uncertain = await pauseSpotify({ client: network });
    assert.equal(uncertain.error.code, 'spotify_action_outcome_uncertain');
    assert.equal(uncertain.outcome, 'uncertain');
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
