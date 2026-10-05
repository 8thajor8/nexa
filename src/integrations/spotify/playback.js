import { SpotifyApiError, spotifyClient } from './client.js';
import { chooseUnambiguousResult, searchSpotify, spotifyFailure } from './search.js';
import { openApp } from '../../tools/windows.js';
import { mediaPlayPause } from '../../windows/audio.js';
import { controlWindow, getActiveWindow, isAppRunning } from '../../windows/window-control.js';

const recoveryDelaysMs = [500, 1000, 1500, 2000];

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function chooseSpotifyDevice(devices) {
    const usable = devices.filter(device =>
        typeof device?.id === 'string' && device.id.length > 0 && device.is_restricted !== true
    );
    if (usable.length === 0) return { status: 'none' };

    const active = usable.filter(device => device.is_active === true);
    if (active.length === 1) return { status: 'found', device: active[0] };
    if (active.length > 1) return { status: 'ambiguous' };

    const desktop = usable.filter(device =>
        device.type === 'computer' && /spotify|desktop|laptop|pc/iu.test(device.name ?? '')
    );
    if (desktop.length === 1) return { status: 'found', device: desktop[0] };
    if (desktop.length > 1 || usable.length > 1) return { status: 'ambiguous' };
    return { status: 'found', device: usable[0] };
}

function recoveryError(code, message) {
    return { success: false, error: { code, message } };
}

async function getRawDevices(client) {
    const response = await client.request('/me/player/devices');
    return Array.isArray(response?.devices) ? response.devices : [];
}

async function activateRunningSpotify({ adapters, client }) {
    const focused = await adapters.focusSpotify();
    if (!focused?.success) return;

    // Only send the global toggle after confirming Spotify is foreground and
    // Spotify reports a known paused item. Never toggle unknown or playing state.
    const [activeWindow, current] = await Promise.all([
        adapters.getActiveWindow(),
        getCurrentSpotifyTrack({ client }),
    ]);
    if (
        activeWindow?.success && activeWindow.window?.process?.toLowerCase() === 'spotify.exe' &&
        current?.success && current.track && current.playing === false
    ) {
        await adapters.playPause();
    }
}

const defaultRecoveryAdapters = {
    isSpotifyRunning: () => isAppRunning({ args: { app: 'spotify' } }),
    openSpotify: () => openApp({ args: { app: 'spotify' } }),
    focusSpotify: () => controlWindow({ target: 'spotify', action: 'focus' }),
    getActiveWindow: () => getActiveWindow(),
    playPause: () => mediaPlayPause(),
    wait,
};

export async function ensureSpotifyDevice({
    client = spotifyClient,
    adapters = {},
} = {}) {
    adapters = { ...defaultRecoveryAdapters, ...adapters };
    let devices;
    try {
        devices = await getRawDevices(client);
    } catch {
        return recoveryError('device_activation_failed', 'No se pudieron consultar los dispositivos de Spotify.');
    }

    let selected = chooseSpotifyDevice(devices);
    if (selected.status === 'found') return { success: true, device: selected.device, recovered: false };
    if (selected.status === 'ambiguous') {
        return recoveryError('ambiguous_device', 'Spotify informa varios dispositivos posibles y ninguno está activo.');
    }

    let running;
    try {
        running = await adapters.isSpotifyRunning();
    } catch {
        return recoveryError('device_activation_failed', 'No se pudo comprobar si Spotify está abierto.');
    }
    if (!running?.success) {
        return recoveryError('device_activation_failed', 'No se pudo comprobar si Spotify está abierto.');
    }

    if (running.running) {
        try {
            await activateRunningSpotify({ adapters, client });
        } catch {
            // Continue bounded device discovery; media activation is optional.
        }
    } else {
        let launched;
        try {
            launched = await adapters.openSpotify();
        } catch {
            launched = null;
        }
        if (!launched?.success) {
            return recoveryError('spotify_launch_failed', launched?.error?.message ?? 'No se pudo abrir Spotify Desktop.');
        }
    }

    for (const delay of recoveryDelaysMs) {
        await adapters.wait(delay);
        try {
            devices = await getRawDevices(client);
        } catch {
            continue;
        }
        selected = chooseSpotifyDevice(devices);
        if (selected.status === 'found') return { success: true, device: selected.device, recovered: true };
        if (selected.status === 'ambiguous') {
            return recoveryError('ambiguous_device', 'Spotify informa varios dispositivos posibles y ninguno está activo.');
        }
    }

    return recoveryError('device_timeout', 'Spotify Desktop no apareció como dispositivo Connect dentro del tiempo esperado.');
}

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

async function sendPlaybackCommand(client, action, { method = 'PUT', body, query } = {}) {
    try {
        const endpoint = {
            pause: '/me/player/pause',
            next: '/me/player/next',
            previous: '/me/player/previous',
            play: '/me/player/play',
        }[action];
        if (!endpoint) throw new SpotifyApiError('spotify_action_invalid', 'Acción de reproducción no válida.');
        await client.request(endpoint, {
            method,
            ...(body && Object.keys(body).length > 0 ? { body } : {}),
            ...(query ? { query } : {}),
        });
        return { success: true, action, confirmed: true };
    } catch (error) {
        return spotifyFailure(error);
    }
}

export async function playSpotify({ query = '', type = 'track', client = spotifyClient, recoveryAdapters } = {}) {
    if (typeof query !== 'string' || query.length > 200 || !['track', 'artist', 'album'].includes(type)) {
        return { success: false, error: { code: 'spotify_query_invalid', message: 'La búsqueda o el tipo de contenido no es válido.' } };
    }
    if (!query.trim()) return playWithDeviceRecovery(client, {}, recoveryAdapters);

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
    const result = await playWithDeviceRecovery(client, body, recoveryAdapters);
    return result.success
        ? { ...result, selected: { type: item.type, name: item.name, artists: item.artists, spotifyUrl: item.spotifyUrl } }
        : result;
}

async function playWithDeviceRecovery(client, body, recoveryAdapters) {
    const firstAttempt = await sendPlaybackCommand(client, 'play', { body });
    if (firstAttempt.success || firstAttempt.error?.code !== 'spotify_no_device') return firstAttempt;

    const recovery = await ensureSpotifyDevice({ client, ...(recoveryAdapters ? { adapters: recoveryAdapters } : {}) });
    if (!recovery.success) return recovery;

    const retried = await sendPlaybackCommand(client, 'play', {
        body,
        query: { device_id: recovery.device.id },
    });
    if (retried.success) return { ...retried, recovered: recovery.recovered };
    if (retried.error?.code === 'spotify_no_device') {
        return recoveryError('playback_failed', 'El dispositivo apareció, pero Spotify no aceptó la reproducción.');
    }
    return retried;
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
