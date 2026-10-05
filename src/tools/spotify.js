import {
    getCurrentSpotifyTrack,
    getSpotifyDevices,
    nextSpotifyTrack,
    pauseSpotify,
    playSpotify,
    previousSpotifyTrack,
} from '../integrations/spotify/playback.js';
import { searchSpotify } from '../integrations/spotify/search.js';

function functionTool(name, description, properties = {}) {
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        },
        strict: true,
    };
}

const queryProperty = {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Texto a buscar en el catálogo de Spotify.',
};
const typeProperty = {
    type: 'string',
    enum: ['track', 'artist', 'album'],
    description: 'Tipo de contenido que se busca o reproduce.',
};

export const spotifyGetCurrentTrackTool = functionTool(
    'spotify_get_current_track',
    'Consulta qué contenido está sonando ahora en Spotify.'
);
export const spotifyGetDevicesTool = functionTool(
    'spotify_get_devices',
    'Lista dispositivos Spotify Connect disponibles con nombre, tipo, estado activo y volumen.'
);
export const spotifySearchTool = functionTool(
    'spotify_search',
    'Busca hasta cinco canciones, artistas o álbumes en Spotify; Nexa presenta los resultados directamente con enlaces y no necesita que el modelo los interprete.',
    { query: queryProperty, type: typeProperty }
);
export const spotifyPlayTool = functionTool(
    'spotify_play',
    'Reanuda Spotify si query está vacío; si no, busca y reproduce solo un resultado exacto y no ambiguo de Spotify.',
    {
        query: { ...queryProperty, minLength: 0, description: 'Búsqueda exacta; cadena vacía para reanudar la reproducción actual.' },
        type: typeProperty,
    }
);
export const spotifyPauseTool = functionTool('spotify_pause', 'Pausa la reproducción actual de Spotify.');
export const spotifyNextTool = functionTool('spotify_next', 'Salta a la siguiente pista de Spotify.');
export const spotifyPreviousTool = functionTool('spotify_previous', 'Vuelve a la pista anterior de Spotify.');

export const spotifyRegistrations = [
    { definition: spotifyGetCurrentTrackTool, execute: getCurrentSpotifyTrack },
    { definition: spotifyGetDevicesTool, execute: getSpotifyDevices },
    { definition: spotifySearchTool, execute: ({ args }) => searchSpotify(args.query, args.type) },
    { definition: spotifyPlayTool, execute: ({ args }) => playSpotify(args) },
    { definition: spotifyPauseTool, execute: pauseSpotify },
    { definition: spotifyNextTool, execute: nextSpotifyTrack },
    { definition: spotifyPreviousTool, execute: previousSpotifyTrack },
];

export function isSpotifyTool(name) {
    return typeof name === 'string' && name.startsWith('spotify_');
}

// Spotify policy prohibits feeding Spotify Content back into a generative model.
// These compact outputs contain control state only; content is formatted locally.
export function spotifyModelSafeOutput(name, result) {
    if (!result?.success) {
        return { success: false, error: { code: result?.error?.code ?? 'spotify_error' } };
    }
    if (name === 'spotify_search') return { success: true, resultsReady: true };
    if (name === 'spotify_get_current_track') {
        return { success: true, playing: result.playing === true, trackAvailable: Boolean(result.track) };
    }
    if (name === 'spotify_get_devices') {
        return { success: true, deviceAvailable: Array.isArray(result.devices) && result.devices.length > 0 };
    }
    return { success: true, confirmed: result.confirmed === true, action: result.action ?? name };
}

function spotifyLink(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'open.spotify.com'
            ? parsed.href
            : 'https://open.spotify.com/';
    } catch {
        return 'https://open.spotify.com/';
    }
}

function displayText(value) {
    return String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/gu, '')
        .replace(/[\\`*_{}\[\]()<>#+\-.!|]/gu, '\\$&');
}

export function formatSpotifyToolResult(name, result) {
    if (!result?.success) {
        const message = result?.error?.message ?? 'Spotify no pudo completar la solicitud.';
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        if (candidates.length === 0) return `Spotify: ${message}`;
        const lines = candidates.map((item, index) => {
            const artists = item.artists?.length ? ` — ${item.artists.map(displayText).join(', ')}` : '';
            return `${index + 1}. ${displayText(item.name)}${artists} ([Spotify](${spotifyLink(item.spotifyUrl)}))`;
        });
        return `Spotify encontró varias opciones. Elegí una con el nombre exacto:\n${lines.join('\n')}`;
    }
    if (name === 'spotify_get_current_track') {
        if (!result.track) return 'Spotify no tiene una reproducción activa ahora.';
        const track = result.track;
        const artists = track.artists?.length ? track.artists.map(displayText).join(', ') : 'artista desconocido';
        const album = track.album ? ` · ${displayText(track.album)}` : '';
        const playback = result.playing ? 'está sonando' : 'está pausado';
        return `En Spotify ${playback} **${displayText(track.name)}** — ${artists}${album}. ([Abrir en Spotify](${spotifyLink(track.spotifyUrl)}))`;
    }
    if (name === 'spotify_search') {
        if (!result.results?.length) return `Spotify no encontró resultados para “${result.query}”.`;
        const lines = result.results.map((item, index) => {
            const artists = item.artists?.length ? ` — ${item.artists.map(displayText).join(', ')}` : '';
            const album = item.album ? ` · ${displayText(item.album)}` : '';
            return `${index + 1}. ${displayText(item.name)}${artists}${album} ([Spotify](${spotifyLink(item.spotifyUrl)}))`;
        });
        return `Resultados de Spotify para “${result.query}”:\n${lines.join('\n')}`;
    }
    if (name === 'spotify_get_devices') {
        if (!result.devices?.length) return 'Spotify no informa dispositivos disponibles. Abrí Spotify en un dispositivo e intentá de nuevo.';
        const lines = result.devices.map(device => {
            const active = device.active ? ' · activo' : '';
            const volume = Number.isInteger(device.volumePercent) ? ` · volumen ${device.volumePercent}%` : '';
            const restricted = device.restricted ? ' · restringido' : '';
            return `• ${displayText(device.name)} (${displayText(device.type)})${active}${volume}${restricted}`;
        });
        return `Dispositivos de Spotify:\n${lines.join('\n')}`;
    }
    if (name === 'spotify_play' && result.selected) {
        const artists = result.selected.artists?.length ? ` — ${result.selected.artists.map(displayText).join(', ')}` : '';
        return `Spotify confirmó la reproducción de **${displayText(result.selected.name)}**${artists}. ([Abrir en Spotify](${spotifyLink(result.selected.spotifyUrl)}))`;
    }
    const messages = {
        spotify_play: 'Spotify confirmó la reproducción.',
        spotify_pause: 'Spotify confirmó la pausa.',
        spotify_next: 'Spotify confirmó el cambio a la siguiente pista.',
        spotify_previous: 'Spotify confirmó el cambio a la pista anterior.',
    };
    return messages[name] ?? 'Spotify completó la solicitud.';
}
