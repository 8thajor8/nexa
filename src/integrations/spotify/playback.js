import { SpotifyApiError, spotifyClient } from './client.js';
import { chooseUnambiguousResult, searchSpotify, spotifyFailure } from './search.js';
import { openApp } from '../../tools/windows.js';
import { mediaPlayPause } from '../../windows/audio.js';
import { controlWindow, getActiveWindow, isAppRunning } from '../../windows/window-control.js';

const recoveryDelaysMs = [500, 1000, 1500, 2000];
const playbackReconciliationDelaysMs = [200, 400];

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

async function getRawDevices(client, { diagnostic, requestId } = {}) {
    const response = await client.request('/me/player/devices', {
        onResponse: status => {
            try { diagnostic?.('spotify_play_preflight', { requestId: requestId ?? null,
                stage: 'device_discovery', httpStatus: Number.isInteger(status) ? status : null }); }
            catch { /* Diagnostics are best effort. */ }
        },
    });
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
    activatePausedPlayback = true,
    diagnostic,
    requestId,
} = {}) {
    adapters = { ...defaultRecoveryAdapters, ...adapters };
    let devices;
    try {
        devices = await getRawDevices(client, { diagnostic, requestId });
    } catch (error) {
        try { diagnostic?.('spotify_play_preflight', { requestId: requestId ?? null, stage: 'device_discovery',
            httpStatus: Number.isInteger(error?.status) ? error.status : null,
            errorCode: typeof error?.code === 'string' ? error.code : 'device_discovery_failed' }); }
        catch { /* Diagnostics are best effort. */ }
        return spotifyFailure(error);
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

    if (running.running && activatePausedPlayback) {
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
            devices = await getRawDevices(client, { diagnostic, requestId });
        } catch (error) {
            try { diagnostic?.('spotify_play_preflight', { requestId: requestId ?? null, stage: 'device_discovery_retry',
                httpStatus: Number.isInteger(error?.status) ? error.status : null,
                errorCode: typeof error?.code === 'string' ? error.code : 'device_discovery_failed' }); }
            catch { /* Diagnostics are best effort. */ }
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

function spotifyAlbumImage(album) {
    if (!Array.isArray(album?.images)) return null;
    for (const image of [...album.images].sort((left, right) => (right?.width ?? 0) - (left?.width ?? 0))) {
        try {
            const url = new URL(image?.url);
            if (url.protocol === 'https:' && url.hostname === 'i.scdn.co' && !url.username && !url.password && !url.port) {
                return url.href;
            }
        } catch { /* Ignore provider image metadata that is not a safe Spotify CDN URL. */ }
    }
    return null;
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
                // Internal reconciliation identifier. It is intentionally omitted from
                // model-safe output and the Now Playing card contract.
                ...(typeof item.id === 'string' && item.id.length > 0 ? { id: item.id } : {}),
                name: item.name,
                artists: Array.isArray(item.artists) ? item.artists.map(artist => artist.name).filter(Boolean) : [],
                album: item.album?.name ?? null,
                imageUrl: spotifyAlbumImage(item.album),
                durationMs: Number.isInteger(item.duration_ms) && item.duration_ms >= 0 ? item.duration_ms : null,
                progressMs: Number.isInteger(response.progress_ms) && response.progress_ms >= 0 ? response.progress_ms : null,
                spotifyUrl: spotifyLink(url),
            },
        };
    } catch (error) {
        return spotifyFailure(error);
    }
}

async function readPlaybackObservation(client, { diagnostic, requestId, phase } = {}) {
    let httpStatus = null;
    try {
        const response = await client.request('/me/player/currently-playing', {
            onResponse: status => { if (Number.isInteger(status)) httpStatus = status; },
        });
        if (!response || typeof response.is_playing !== 'boolean') {
            try { diagnostic?.('spotify_playback_observation', { requestId: requestId ?? null, phase: phase ?? 'reconciliation',
                known: false, reason: response ? 'playing_state_missing' : 'empty_or_no_active_playback', httpStatus }); }
            catch { /* Diagnostics are best effort. */ }
            return null;
        }
        const observation = {
            playing: response.is_playing,
            trackId: typeof response.item?.id === 'string' && response.item.id.length > 0 ? response.item.id : null,
            trackUri: typeof response.item?.uri === 'string' ? response.item.uri : null,
            contextUri: typeof response.context?.uri === 'string' ? response.context.uri : null,
            progressMs: Number.isInteger(response.progress_ms) && response.progress_ms >= 0 ? response.progress_ms : null,
        };
        try { diagnostic?.('spotify_playback_observation', { requestId: requestId ?? null, phase: phase ?? 'reconciliation',
            known: true, playing: observation.playing, httpStatus }); }
        catch { /* Diagnostics are best effort. */ }
        return observation;
    } catch (error) {
        try { diagnostic?.('spotify_playback_observation', { requestId: requestId ?? null, phase: phase ?? 'reconciliation',
            known: false, reason: typeof error?.code === 'string' ? error.code : 'read_failed',
            httpStatus: Number.isInteger(error?.status) ? error.status : httpStatus }); }
        catch { /* Diagnostics are best effort. */ }
        return null;
    }
}

function classifyPlaybackObservation(action, before, after, intent = {}) {
    if (!after) return 'unavailable';
    // A bodyless currently-playing response is a valid unknown observation (for
    // example, Spotify can return 204 when no item is available). Preserve that
    // unknown state instead of treating it as paused. A later active state is
    // useful evidence for Play, but cannot prove this write caused it.
    if (!before && action === 'play') {
        if (intent.trackUri && after.trackUri !== intent.trackUri) return 'target_not_observed';
        if (intent.contextUri && after.contextUri !== intent.contextUri) return 'target_not_observed';
        return after.playing ? 'target_state_observed' : 'target_not_observed';
    }
    if (!before) return 'unavailable';
    if (action === 'next') {
        if (!before.trackId || !after.trackId) return 'unavailable';
        return before.trackId === after.trackId ? 'unchanged' : 'track_changed_observed';
    }
    if (action === 'previous') {
        if (!before.trackId || !after.trackId) return 'unavailable';
        if (before.trackId !== after.trackId) return 'track_changed_observed';
        // Spotify's Previous command restarts the current track when playback
        // has passed its initial three-second window. Require both sides of
        // that boundary before confirming a restart; otherwise remain unsure.
        if (before.progressMs !== null && before.progressMs > 3_000
            && after.progressMs !== null && after.progressMs <= 3_000) return 'previous_track_restarted_observed';
        return 'unchanged';
    }
    const target = action === 'play';
    if (action === 'play' && intent.trackUri && after.trackUri !== intent.trackUri) return 'target_not_observed';
    if (action === 'play' && intent.contextUri && after.contextUri !== intent.contextUri) return 'target_not_observed';
    if (after.playing === target) {
        if (before.playing === target) return 'target_already_observed';
        return before.playing === !target ? 'target_transition_observed' : 'target_state_observed';
    }
    return before.playing === after.playing ? 'unchanged' : 'target_not_observed';
}

async function reconcilePlaybackObservation(client, action, before, intent, trace = {}) {
    let after = await readPlaybackObservation(client, { ...trace, phase: 'after_action' });
    let verification = classifyPlaybackObservation(action, before, after, intent);
    // Playback status can lag the write response. Retry reads only, never the action.
    for (const delay of playbackReconciliationDelaysMs) {
        if (!['unchanged', 'target_not_observed'].includes(verification)) break;
        await wait(delay);
        after = await readPlaybackObservation(client, { ...trace, phase: 'after_action' });
        verification = classifyPlaybackObservation(action, before, after, intent);
    }
    const evidence = observationEvidence(action, before, after, intent, verification);
    return { verification, evidence };
}

function observationEvidence(action, before, after, intent, verification) {
    const observed = value => value ? { playing: value.playing, trackAvailable: Boolean(value.trackId) } : null;
    return {
        before: observed(before),
        after: observed(after),
        trackChanged: before?.trackId && after?.trackId ? before.trackId !== after.trackId : null,
        requestedTargetMatched: intent.trackUri ? after?.trackUri === intent.trackUri
            : intent.contextUri ? after?.contextUri === intent.contextUri : null,
        previousTrackRestartObserved: action === 'previous' && verification === 'previous_track_restarted_observed',
        verification,
    };
}

export function formatSpotifyActionOutcome(action, outcome, verification = 'unavailable') {
    const names = { play: 'reproducción', pause: 'pausa', next: 'avance', previous: 'cambio a la pista anterior' };
    if (outcome === 'provider_accepted' || outcome === 'accepted') return `Spotify aceptó la orden de ${names[action] ?? 'reproducción'}.`;
    const targetObserved = ['target_transition_observed', 'target_already_observed', 'target_state_observed'].includes(verification);
    if (action === 'play' && targetObserved && ['state_confirmed', 'uncertain'].includes(outcome)) return 'Spotify está reproduciendo';
    if (action === 'pause' && targetObserved && ['state_confirmed', 'uncertain'].includes(outcome)) return 'Spotify pausado';
    if (['next', 'previous'].includes(action) && verification === 'track_changed_observed' && outcome === 'uncertain') return 'Canción cambiada';
    if (action === 'previous' && verification === 'previous_track_restarted_observed' && ['state_confirmed', 'uncertain'].includes(outcome)) return 'Canción reiniciada';
    if (outcome === 'state_confirmed') {
        if (verification === 'target_transition_observed') return action === 'pause' ? 'Spotify pausado' : 'Reproducción iniciada';
        if (verification === 'target_already_observed') return action === 'pause'
            ? 'Spotify ya estaba en pausa; el estado solicitado está confirmado.'
            : 'Spotify ya estaba reproduciendo; el estado solicitado está confirmado.';
        if (verification === 'previous_track_restarted_observed') return 'Spotify reinició la pista actual.';
        return 'El estado solicitado de Spotify está confirmado.';
    }
    if (outcome !== 'uncertain') return null;
    if (verification === 'target_transition_observed') {
        return action === 'pause' ? 'Spotify aparece en pausa. La respuesta de la orden no fue la habitual.'
            : 'Spotify aparece reproduciendo. La respuesta de la orden no fue la habitual.';
    }
    if (verification === 'target_already_observed') {
        return action === 'pause' ? 'Spotify ya aparece en pausa. La respuesta de la orden no fue la habitual; no puedo atribuir ese estado a esta orden.'
            : 'Spotify ya aparece reproduciendo. La respuesta de la orden no fue la habitual; no puedo atribuir ese estado a esta orden.';
    }
    if (verification === 'target_state_observed') {
        return action === 'pause' ? 'Spotify aparece en pausa, pero no pude confirmar si esta orden la pausó.'
            : 'Spotify está reproduciendo. No pude confirmar si esta orden inició la reproducción.';
    }
    if (verification === 'track_changed_observed') {
        return 'Spotify cambió de canción, pero no pude confirmar la dirección del cambio.';
    }
    if (verification === 'unchanged') {
        return 'Spotify no confirmó la orden y la lectura posterior no muestra un cambio verificable. No la repetí automáticamente.';
    }
    if (verification === 'target_not_observed') {
        return 'La lectura posterior no muestra el estado solicitado. El resultado de la orden sigue siendo incierto y no la repetí automáticamente.';
    }
    return 'No pude confirmar el resultado de la orden. No la repetí automáticamente.';
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

async function sendPlaybackCommand(client, action, { method = 'PUT', body, query, diagnostic, requestId } = {}) {
    const before = await readPlaybackObservation(client, { diagnostic, requestId, phase: 'before_action' });
    const intent = {
        ...(Array.isArray(body?.uris) && body.uris.length === 1 && typeof body.uris[0] === 'string' ? { trackUri: body.uris[0] } : {}),
        ...(typeof body?.context_uri === 'string' ? { contextUri: body.context_uri } : {}),
    };
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
            responseContract: 'no-content',
            ...(body && Object.keys(body).length > 0 ? { body } : {}),
            ...(query ? { query } : {}),
            ...(typeof diagnostic === 'function' ? { onResponse: (status, metadata = {}) => {
                try {
                    const bodyStage = metadata?.stage === 'response_body';
                    diagnostic?.(bodyStage ? 'spotify_response_body' : 'spotify_provider_response', {
                        tool: `spotify_${action}`, requestId: requestId ?? null, httpStatus: status,
                        ...(metadata && typeof metadata === 'object' ? metadata : {}),
                    });
                } catch { /* Diagnostics are best effort. */ }
            } } : {}),
        });
        const result = { success: true, action, accepted: true, outcome: 'provider_accepted', postStateConfirmed: false, confirmed: true,
            verification: 'not_required' };
        try { diagnostic?.('spotify_action_result', { tool: `spotify_${action}`, requestId: requestId ?? null,
            outcome: 'provider_accepted', stage: 'provider_write', reconciliation: 'not_attempted' }); } catch { /* Diagnostics are best effort. */ }
        return result;
    } catch (error) {
        if (['spotify_network_error', 'spotify_service_unavailable', 'spotify_unexpected_write_response'].includes(error?.code)) {
            const reconciliation = await reconcilePlaybackObservation(client, action, before, intent, { diagnostic, requestId });
            const { verification, evidence } = reconciliation;
            const stateConfirmed = action === 'play' || action === 'pause'
                ? ['target_transition_observed', 'target_already_observed'].includes(verification)
                : action === 'previous' && verification === 'previous_track_restarted_observed';
            if (stateConfirmed) {
                const result = { success: true, action, accepted: false, confirmed: true, stateConfirmed: true,
                    postStateConfirmed: true, outcome: 'state_confirmed', verification, verificationEvidence: evidence,
                    providerResponse: 'undocumented' };
                try { diagnostic?.('spotify_action_result', { tool: `spotify_${action}`, requestId: requestId ?? null,
                    outcome: 'state_confirmed', stage: 'post_state_verification', verification,
                    providerResponse: 'undocumented', providerStatus: error?.status ?? null,
                    beforePlaying: evidence.before?.playing ?? null, afterPlaying: evidence.after?.playing ?? null,
                    trackChanged: evidence.trackChanged, requestedTargetMatched: evidence.requestedTargetMatched,
                    previousTrackRestartObserved: evidence.previousTrackRestartObserved }); } catch { /* Diagnostics are best effort. */ }
                return result;
            }
            const result = {
                success: false,
                outcome: 'uncertain',
                action,
                verification,
                verificationEvidence: evidence,
                error: {
                    code: 'spotify_action_outcome_uncertain',
                    message: formatSpotifyActionOutcome(action, 'uncertain', verification),
                },
            };
            try { diagnostic?.('spotify_action_result', { tool: `spotify_${action}`, requestId: requestId ?? null,
                outcome: 'uncertain', stage: 'provider_write', errorCode: result.error.code,
                verification, providerResponse: error?.code === 'spotify_unexpected_write_response' ? 'undocumented' : 'unavailable',
                beforePlaying: evidence.before?.playing ?? null, afterPlaying: evidence.after?.playing ?? null,
                trackChanged: evidence.trackChanged, requestedTargetMatched: evidence.requestedTargetMatched,
                previousTrackRestartObserved: evidence.previousTrackRestartObserved }); } catch { /* Diagnostics are best effort. */ }
            return result;
        }
        const result = { ...spotifyFailure(error), outcome: error?.status ? 'rejected' : 'blocked' };
        try { diagnostic?.('spotify_action_result', { tool: `spotify_${action}`, requestId: requestId ?? null,
            outcome: result.outcome, stage: 'provider_write', httpStatus: error?.status ?? null, errorCode: result.error?.code ?? null }); }
        catch { /* Diagnostics are best effort. */ }
        return result;
    }
}

export async function playSpotify({ query = '', type = 'track', client = spotifyClient, recoveryAdapters, diagnostic, requestId } = {}) {
    if (typeof query !== 'string' || query.length > 200 || !['track', 'artist', 'album'].includes(type)) {
        return { success: false, error: { code: 'spotify_query_invalid', message: 'La búsqueda o el tipo de contenido no es válido.' } };
    }
    if (!query.trim()) return playWithDeviceRecovery(client, {}, recoveryAdapters, { diagnostic, requestId });

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
    const result = await playWithDeviceRecovery(client, body, recoveryAdapters, { diagnostic, requestId });
    return result.success
        ? { ...result, selected: { type: item.type, name: item.name, artists: item.artists, spotifyUrl: item.spotifyUrl } }
        : result;
}

async function playWithDeviceRecovery(client, body, recoveryAdapters, trace = {}) {
    const recovery = await ensureSpotifyDevice({ client, activatePausedPlayback: false, ...trace,
        ...(recoveryAdapters ? { adapters: recoveryAdapters } : {}) });
    if (!recovery.success) return recovery;
    // Resolve a single usable device before the write. This avoids replaying a
    // playback command after an HTTP rejection such as 404/no-device.
    const result = await sendPlaybackCommand(client, 'play', {
        body,
        query: { device_id: recovery.device.id },
        ...trace,
    });
    return result.success && recovery.recovered ? { ...result, recovered: true } : result;
}

export async function pauseSpotify({ client = spotifyClient, diagnostic, requestId } = {}) {
    return sendPlaybackCommand(client, 'pause', { diagnostic, requestId });
}

export async function nextSpotifyTrack({ client = spotifyClient, diagnostic, requestId } = {}) {
    return sendPlaybackCommand(client, 'next', { method: 'POST', diagnostic, requestId });
}

export async function previousSpotifyTrack({ client = spotifyClient, diagnostic, requestId } = {}) {
    return sendPlaybackCommand(client, 'previous', { method: 'POST', diagnostic, requestId });
}
