import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { loadSpotifyTokens, saveSpotifyTokens } from './token-store.js';

export const spotifyScopes = Object.freeze([
    'user-read-playback-state',
    'user-read-currently-playing',
    'user-modify-playback-state',
]);

export const defaultSpotifyRedirectUri = 'http://127.0.0.1:8888/callback';
const authorizeEndpoint = 'https://accounts.spotify.com/authorize';
const tokenEndpoint = 'https://accounts.spotify.com/api/token';

export class SpotifyAuthError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'SpotifyAuthError';
        this.code = code;
    }
}

export function getSpotifyConfiguration(environment = process.env) {
    const clientId = typeof environment.SPOTIFY_CLIENT_ID === 'string'
        ? environment.SPOTIFY_CLIENT_ID.trim()
        : '';
    const redirectUri = typeof environment.SPOTIFY_REDIRECT_URI === 'string'
        ? environment.SPOTIFY_REDIRECT_URI.trim() || defaultSpotifyRedirectUri
        : defaultSpotifyRedirectUri;
    let parsedRedirect;
    try {
        parsedRedirect = new URL(redirectUri);
    } catch {
        throw new SpotifyAuthError('spotify_config_invalid', 'SPOTIFY_REDIRECT_URI no es válida.');
    }
    if (
        !clientId || clientId.length > 256 ||
        parsedRedirect.protocol !== 'http:' ||
        parsedRedirect.hostname !== '127.0.0.1' ||
        parsedRedirect.pathname !== '/callback' ||
        parsedRedirect.search || parsedRedirect.hash ||
        parsedRedirect.port !== '8888'
    ) {
        throw new SpotifyAuthError(
            'spotify_config_missing',
            'Configurá SPOTIFY_CLIENT_ID y la redirect URI local esperada en .env.'
        );
    }
    return { clientId, redirectUri: defaultSpotifyRedirectUri };
}

function base64Url(buffer) {
    return buffer.toString('base64').replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

export function createSpotifyAuthorizationUrl({ clientId, redirectUri = defaultSpotifyRedirectUri } = {}) {
    const verifier = base64Url(randomBytes(48));
    const state = base64Url(randomBytes(24));
    const challenge = base64Url(createHash('sha256').update(verifier).digest());
    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: spotifyScopes.join(' '),
        code_challenge_method: 'S256',
        code_challenge: challenge,
        state,
    }).toString();
    return { url: url.toString(), verifier, state };
}

export function spotifyCallbackPage(status) {
    const content = {
        success: { title: 'Spotify conectado', heading: 'Spotify conectado', copy: 'Nexa ya puede usar tu conexión de Spotify. Volvé a Nexa para continuar.' },
        cancelled: { title: 'Conexión cancelada', heading: 'Conexión cancelada', copy: 'No se realizaron cambios. Podés volver a Nexa e intentarlo cuando quieras.' },
        failed: { title: 'No se pudo conectar', heading: 'No se pudo conectar con Spotify', copy: 'La conexión no se completó. Volvé a Nexa para revisar el estado e intentarlo de nuevo.' },
    }[status] ?? { title: 'No se pudo conectar', heading: 'No se pudo conectar con Spotify', copy: 'La conexión no se completó. Volvé a Nexa para revisar el estado e intentarlo de nuevo.' };
    const symbol = status === 'success' ? '✓' : status === 'cancelled' ? '↩' : '!';
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${content.title} · Nexa</title><style>:root{color-scheme:dark;font-family:Segoe UI,Inter,Arial,sans-serif;background:#050b17;color:#e8f5ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 0%,rgba(17,108,183,.28),transparent 55%),linear-gradient(145deg,#071326,#030711)}main{width:min(480px,100%);padding:34px;border:1px solid rgba(92,190,255,.35);border-radius:18px;background:rgba(8,20,39,.9);box-shadow:0 22px 70px rgba(0,0,0,.5),0 0 34px rgba(36,164,255,.12);text-align:center}mark{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 20px;border:1px solid rgba(79,221,255,.5);border-radius:50%;background:rgba(27,132,189,.2);color:#71e4ff;font-size:24px}small{color:#75dfff;font-weight:700;letter-spacing:.2em;text-transform:uppercase}h1{margin:12px 0;color:#f3faff;font-size:25px;line-height:1.2}p{margin:0;color:#b6cce1;font-size:15px;line-height:1.65}footer{margin-top:26px;color:#7896b1;font-size:12px}</style></head><body><main><mark aria-hidden="true">${symbol}</mark><small>Nexa · Spotify</small><h1>${content.heading}</h1><p>${content.copy}</p><footer>Podés cerrar esta pestaña después de volver a Nexa.</footer></main></body></html>`;
}

async function postTokenForm(body, fetchImpl = fetch) {
    let response;
    try {
        response = await fetchImpl(tokenEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(body),
            signal: AbortSignal.timeout(15_000),
        });
    } catch {
        throw new SpotifyAuthError('spotify_network_error', 'No se pudo conectar con la autorización de Spotify.');
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || typeof payload.access_token !== 'string') {
        const code = payload.error === 'invalid_grant'
            ? 'spotify_reauthorization_required'
            : 'spotify_auth_failed';
        throw new SpotifyAuthError(code, 'Spotify rechazó la autorización o renovación del token.');
    }
    return payload;
}

function tokensFromResponse(payload, previous = {}) {
    const now = Date.now();
    return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? previous.refreshToken ?? null,
        expiresAt: now + Math.max(0, Number(payload.expires_in) || 3600) * 1000,
        scope: typeof payload.scope === 'string' ? payload.scope.split(/\s+/u).filter(Boolean) : previous.scope ?? [],
    };
}

export async function exchangeSpotifyAuthorizationCode({ code, verifier, environment = process.env, fetchImpl = fetch, tokenStore = { save: saveSpotifyTokens } } = {}) {
    const { clientId, redirectUri } = getSpotifyConfiguration(environment);
    const payload = await postTokenForm({
        client_id: clientId,
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
    }, fetchImpl);
    const tokens = tokensFromResponse(payload);
    if (!tokens.refreshToken) {
        throw new SpotifyAuthError('spotify_refresh_missing', 'Spotify no devolvió un refresh token; volvé a iniciar la autorización.');
    }
    await tokenStore.save(tokens);
    return tokens;
}

export async function refreshSpotifyTokens({ refreshToken, environment = process.env, fetchImpl = fetch, tokenStore = { save: saveSpotifyTokens }, previous = {} } = {}) {
    const { clientId } = getSpotifyConfiguration(environment);
    if (typeof refreshToken !== 'string' || !refreshToken) {
        throw new SpotifyAuthError('spotify_auth_required', 'Spotify todavía no está autorizado. Ejecutá npm run spotify:auth.');
    }
    const payload = await postTokenForm({
        client_id: clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
    }, fetchImpl);
    const tokens = tokensFromResponse(payload, { ...previous, refreshToken });
    await tokenStore.save(tokens);
    return tokens;
}

export async function getSpotifyAccessToken({ environment = process.env, tokenStore = { load: loadSpotifyTokens, save: saveSpotifyTokens }, fetchImpl = fetch, now = Date.now, forceRefresh = false } = {}) {
    try {
        const tokens = await tokenStore.load();
        if (!tokens?.refreshToken) {
            throw new SpotifyAuthError('spotify_auth_required', 'Spotify todavía no está autorizado. Ejecutá npm run spotify:auth.');
        }
        if (!forceRefresh && typeof tokens.accessToken === 'string' && tokens.expiresAt > now() + 30_000) {
            return tokens.accessToken;
        }
        const refreshed = await refreshSpotifyTokens({
            refreshToken: tokens.refreshToken,
            environment,
            fetchImpl,
            tokenStore,
            previous: tokens,
        });
        return refreshed.accessToken;
    } catch (error) {
        if (error instanceof SpotifyAuthError) throw error;
        throw new SpotifyAuthError('spotify_token_store_error', 'No se pudo leer o guardar la autorización local de Spotify.');
    }
}

export async function authorizeSpotify({ environment = process.env, fetchImpl = fetch, tokenStore = { save: saveSpotifyTokens },
    output = console.log, browserOpener = null, signal = null } = {}) {
    const { clientId, redirectUri } = getSpotifyConfiguration(environment);
    const authorization = createSpotifyAuthorizationUrl({ clientId, redirectUri });
    const callback = new URL(redirectUri);

    return new Promise((resolve, reject) => {
        let settled = false;
        let timeout;
        const server = createServer(async (request, response) => {
            if (settled) return;
            const requestUrl = new URL(request.url, redirectUri);
            if (requestUrl.pathname !== callback.pathname) {
                response.writeHead(404).end('Not found');
                return;
            }
            if (requestUrl.searchParams.get('state') !== authorization.state) {
                response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
                    .end(spotifyCallbackPage('failed'));
                finish(new SpotifyAuthError('spotify_state_mismatch', 'Spotify devolvió un estado OAuth inválido.'));
                return;
            }
            const code = requestUrl.searchParams.get('code');
            if (!code) {
                const denied = requestUrl.searchParams.get('error') === 'access_denied';
                const cancelled = denied || !requestUrl.searchParams.has('error');
                response.writeHead(cancelled ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
                    .end(spotifyCallbackPage(cancelled ? 'cancelled' : 'failed'));
                finish(new SpotifyAuthError(cancelled ? 'spotify_authorization_cancelled' : 'spotify_authorization_denied',
                    cancelled ? 'Spotify no completó la autorización.' : 'Spotify devolvió un error de autorización.'));
                return;
            }
            try {
                const tokens = await exchangeSpotifyAuthorizationCode({
                    code,
                    verifier: authorization.verifier,
                    environment,
                    fetchImpl,
                    tokenStore,
                });
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
                    .end(spotifyCallbackPage('success'));
                finish(null, tokens);
            } catch (error) {
                response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
                    .end(spotifyCallbackPage('failed'));
                finish(error);
            }
        });
        function finish(error, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener?.('abort', onAbort);
            try { server.close(); } catch { /* The listener may not have started yet. */ }
            if (error) reject(error); else resolve(value);
        }
        function onAbort() {
            finish(new SpotifyAuthError('spotify_authorization_cancelled', 'La autorización de Spotify fue cancelada.'));
        }
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener?.('abort', onAbort, { once: true });
        server.once('error', () => finish(new SpotifyAuthError(
            'spotify_callback_unavailable', 'No se pudo abrir el callback local 127.0.0.1:8888.'
        )));
        server.listen(Number(callback.port), '127.0.0.1', () => {
            Promise.resolve(browserOpener
                ? browserOpener(authorization.url)
                : output(`Abrí este enlace para autorizar Nexa con Spotify:\n${authorization.url}`))
                .catch(() => finish(new SpotifyAuthError('spotify_browser_unavailable',
                    'No se pudo abrir el navegador para autorizar Spotify.')));
        });
        timeout = setTimeout(() => {
            finish(new SpotifyAuthError('spotify_authorization_timeout', 'Se agotó el tiempo de espera para autorizar Spotify.'));
        }, 5 * 60_000);
    });
}
