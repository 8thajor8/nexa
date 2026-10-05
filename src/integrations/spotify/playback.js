import { SpotifyApiError, spotifyClient } from './client.js';
import { chooseUnambiguousResult, searchSpotify, spotifyFailure } from './search.js';

function spotifyLink(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === 'open.spotify.com' ? url.href : null;
    } catch {
        return null;
    }
}

export async function getCurrentSpotifyTrack({ client = spotifyClient } = {}) {
    try {
        const response = await client.request('/me/player/currently-playing');
        const item = response?.item;
        if (!response || !item) return { success: true, playing: false, track: null };
        const url = item.external_urls?.spotify;
        return {
            success: true,
            playing: response.is_playing === true,
            track: {
                name: item.name,
                artists: Array.isArray(item.artists) ? item.artists.map(artist => artist.name).filter(Boolean) : [],
                album: item.album?.name ?? null,
                durationMs: Number.isInteger(item.duration_ms) && item.duration_ms >= 0 ? item.duration_ms : null,
                progressMs: Number.isInteger(response.progress_ms) && response.progress_ms >= 0 ? response.progress_ms : null,
                spotifyUrl: spotifyLink(url),
            },
        };
    } catch (error) {
        return spotifyFailure(error);
    }
}

export async function getSpotifyDevices({ client = spotifyClient } = {}) {
    try {
        const response = await client.request('/me/player/devices');
        const devices = Array.isArray(response?.devices) ? response.devices : [];
        return {
            success: true,
            devices: devices.slice(0, 20).map(device => ({
                name: device.name,
                type: device.type,
                active: device.is_active === true,
                volumePercent: Number.isInteger(device.volume_percent) && device.volume_percent >= 0 && device.volume_percent <= 100
                    ? device.volume_percent
                    : null,
                restricted: device.is_restricted === true,
            })),
        };
    } catch (error) {
        return spotifyFailure(error);
    }
}

async function sendPlaybackCommand(client, action, { method = 'PUT', body } = {}) {
    try {
        const endpoint = {
            pause: '/me/player/pause',
            next: '/me/player/next',
            previous: '/me/player/previous',
            play: '/me/player/play',
        }[action];
        if (!endpoint) throw new SpotifyApiError('spotify_action_invalid', 'Acción de reproducción no válida.');
        await client.request(endpoint, { method, ...(body ? { body } : {}) });
        return { success: true, action, confirmed: true };
    } catch (error) {
        return spotifyFailure(error);
    }
}

export async function playSpotify({ query = '', type = 'track', client = spotifyClient } = {}) {
    if (typeof query !== 'string' || query.length > 200 || !['track', 'artist', 'album'].includes(type)) {
        return { success: false, error: { code: 'spotify_query_invalid', message: 'La búsqueda o el tipo de contenido no es válido.' } };
    }
    if (!query.trim()) return sendPlaybackCommand(client, 'play');

    const search = await searchSpotify(query, type, { client });
    if (!search.success) return search;
    if (search.results.length === 0) {
        return { success: false, error: { code: 'spotify_no_results', message: 'Spotify no encontró resultados para esa búsqueda.' } };
    }
    const selection = chooseUnambiguousResult(query, search.results);
    if (selection.status !== 'found') {
        return {
            success: false,
            error: {
                code: 'spotify_ambiguous_result',
                message: 'Hay varios resultados posibles; elegí uno con el nombre y artista exactos.',
            },
            candidates: selection.items,
        };
    }
    const item = selection.item;
    const body = item.type === 'track'
        ? { uris: [item.uri] }
        : { context_uri: item.uri };
    const result = await sendPlaybackCommand(client, 'play', { body });
    return result.success
        ? { ...result, selected: { type: item.type, name: item.name, artists: item.artists, spotifyUrl: item.spotifyUrl } }
        : result;
}

export async function pauseSpotify({ client = spotifyClient } = {}) {
    return sendPlaybackCommand(client, 'pause');
}

export async function nextSpotifyTrack({ client = spotifyClient } = {}) {
    return sendPlaybackCommand(client, 'next', { method: 'POST' });
}

export async function previousSpotifyTrack({ client = spotifyClient } = {}) {
    return sendPlaybackCommand(client, 'previous', { method: 'POST' });
}
