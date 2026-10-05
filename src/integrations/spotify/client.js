import { getSpotifyAccessToken, SpotifyAuthError } from './auth.js';

export class SpotifyApiError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = 'SpotifyApiError';
        this.code = code;
        Object.assign(this, details);
    }
}

function mapHttpError(status, retryAfter) {
    if (status === 401) return new SpotifyApiError('spotify_auth_expired', 'Spotify rechazó el token. Volvé a autorizar Nexa.');
    if (status === 403) return new SpotifyApiError('spotify_scope_or_premium_required', 'Spotify rechazó la operación por permisos insuficientes o una limitación de la cuenta.');
    if (status === 404) return new SpotifyApiError('spotify_no_device', 'No hay un dispositivo Spotify disponible para esta operación.');
    if (status === 429) return new SpotifyApiError('spotify_rate_limited', 'Spotify pidió reducir la frecuencia de solicitudes.', { retryAfter });
    if (status >= 500) return new SpotifyApiError('spotify_service_unavailable', 'Spotify no está disponible en este momento.');
    return new SpotifyApiError('spotify_api_error', 'Spotify no pudo completar la solicitud.');
}

export class SpotifyClient {
    constructor({ fetchImpl = fetch, getAccessToken = getSpotifyAccessToken, tokenOptions = {} } = {}) {
        this.fetchImpl = fetchImpl;
        this.getAccessToken = getAccessToken;
        this.tokenOptions = tokenOptions;
    }

    async request(endpoint, { method = 'GET', query, body } = {}) {
        const url = new URL(`https://api.spotify.com/v1/${endpoint.replace(/^\//u, '')}`);
        if (query) url.search = new URLSearchParams(query).toString();
        let retriedAuth = false;
        while (true) {
            let accessToken;
            try {
                accessToken = await this.getAccessToken(this.tokenOptions);
                this.tokenOptions = { ...this.tokenOptions, forceRefresh: false };
            } catch (error) {
                if (error instanceof SpotifyAuthError) throw error;
                throw new SpotifyApiError('spotify_auth_error', 'No se pudo obtener autorización para Spotify.');
            }

            let response;
            try {
                response = await this.fetchImpl(url, {
                    method,
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        ...(body ? { 'Content-Type': 'application/json' } : {}),
                    },
                    ...(body ? { body: JSON.stringify(body) } : {}),
                    signal: AbortSignal.timeout(15_000),
                });
            } catch {
                throw new SpotifyApiError('spotify_network_error', 'No se pudo conectar con Spotify.');
            }

            if (response.status === 204) return null;
            if (response.status === 401 && !retriedAuth) {
                retriedAuth = true;
                this.tokenOptions = { ...this.tokenOptions, forceRefresh: true };
                continue;
            }
            if (!response.ok) throw mapHttpError(response.status, response.headers?.get?.('retry-after'));
            if (response.status === 204) return null;
            try {
                return await response.json();
            } catch {
                throw new SpotifyApiError('spotify_invalid_response', 'Spotify devolvió una respuesta que Nexa no pudo interpretar.');
            }
        }
    }
}

export const spotifyClient = new SpotifyClient();
