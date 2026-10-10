import { getSpotifyAccessToken, SpotifyAuthError, startSpotifyAuthorizationFlow } from './auth.js';
import { loadSpotifyTokens, saveSpotifyTokens } from './token-store.js';

const defaultTokenStore = Object.freeze({ load: loadSpotifyTokens, save: saveSpotifyTokens });

function publicError(error) {
    const code = typeof error?.code === 'string' ? error.code : 'spotify_auth_failed';
    const messages = {
        spotify_authorization_cancelled: 'La autorización de Spotify fue cancelada.',
        spotify_authorization_denied: 'La autorización de Spotify fue cancelada o denegada.',
        spotify_authorization_timeout: 'Se agotó el tiempo para autorizar Spotify.',
        spotify_reauthorization_required: 'La autorización de Spotify venció; es necesario volver a conectar la cuenta.',
        spotify_auth_required: 'Spotify todavía no está conectado.',
        spotify_config_missing: 'Falta la configuración de Spotify en el proceso principal.',
        spotify_config_invalid: 'La configuración de Spotify no es válida.',
        spotify_token_store_error: 'No se pudo acceder al almacenamiento local de Spotify.',
        spotify_network_error: 'No se pudo conectar con Spotify.',
        spotify_callback_unavailable: 'No se pudo iniciar el callback local de Spotify.',
        spotify_state_mismatch: 'Spotify devolvió un callback no válido.',
        spotify_auth_failed: 'Spotify no pudo completar la autorización.',
    };
    return Object.freeze({ code, message: messages[code] ?? 'No se pudo completar la autorización de Spotify.' });
}

/**
 * Main-process interface for explicit Spotify account authorization.
 * It never returns tokens; the authorization URL belongs only in trusted
 * Main-process code that opens it in the system browser.
 */
export function createSpotifyAuthorizationRuntime({
    environment = process.env,
    fetchImpl = fetch,
    tokenStore = defaultTokenStore,
} = {}) {
    let active = null;
    let closed = false;

    async function getStatus() {
        if (closed) return Object.freeze({ status: 'error', error: publicError({ code: 'spotify_runtime_closed' }) });
        try {
            await getSpotifyAccessToken({ environment, fetchImpl, tokenStore });
            return Object.freeze({ status: 'connected' });
        } catch (error) {
            if (error?.code === 'spotify_auth_required') return Object.freeze({ status: 'not_connected' });
            if (error?.code === 'spotify_reauthorization_required')
                return Object.freeze({ status: 'reauthorization_required', error: publicError(error) });
            return Object.freeze({ status: 'error', error: publicError(error) });
        }
    }

    async function startAuthorization({ force = false } = {}) {
        if (closed) throw new SpotifyAuthError('spotify_runtime_closed', 'El servicio local de Spotify está cerrado.');
        if (typeof force !== 'boolean') throw new TypeError('spotify_authorization_options_invalid');
        if (active) throw new SpotifyAuthError('spotify_authorization_in_progress', 'Ya hay una autorización de Spotify en curso.');

        const entry = { controller: new AbortController(), flow: null, startPromise: null };
        active = entry;
        try {
            if (!force) {
                const status = await getStatus();
                if (status.status === 'connected') {
                    active = null;
                    return Object.freeze({
                        authorizationUrl: null,
                        alreadyConnected: true,
                        completion: Promise.resolve(Object.freeze({ status: 'connected' })),
                        cancel: () => false,
                    });
                }
                if (status.status !== 'not_connected' && status.status !== 'reauthorization_required') {
                    throw new SpotifyAuthError(status.error?.code ?? 'spotify_auth_status_unavailable',
                        status.error?.message ?? 'No se pudo verificar la autorización de Spotify.');
                }
            }
            if (closed || entry.controller.signal.aborted) {
                throw new SpotifyAuthError('spotify_authorization_cancelled', 'La autorización de Spotify fue cancelada.');
            }

            entry.startPromise = startSpotifyAuthorizationFlow({
                environment,
                fetchImpl,
                tokenStore,
                signal: entry.controller.signal,
            });
            const flow = await entry.startPromise;
            entry.flow = flow;
            const completion = flow.completion.then(
                () => Object.freeze({ status: 'connected' }),
                error => error?.code === 'spotify_authorization_cancelled' || error?.code === 'spotify_authorization_denied'
                    ? Object.freeze({ status: 'cancelled' })
                    : Object.freeze({ status: 'error', error: publicError(error) })
            ).finally(() => {
                if (active === entry) active = null;
            });
            return Object.freeze({
                authorizationUrl: flow.authorizationUrl,
                alreadyConnected: false,
                completion,
                cancel() {
                    if (active !== entry) return false;
                    if (entry.flow) return entry.flow.cancel();
                    entry.controller.abort();
                    return true;
                },
            });
        } catch (error) {
            if (active === entry) active = null;
            throw error;
        }
    }

    async function close() {
        if (closed) return;
        closed = true;
        const entry = active;
        if (!entry) return;
        entry.controller.abort();
        if (entry.flow) await entry.flow.completion.catch(() => {});
        else if (entry.startPromise) await entry.startPromise.then(flow => flow.completion.catch(() => {}), () => {});
    }

    return Object.freeze({ getStatus, startAuthorization, close });
}
