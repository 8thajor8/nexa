import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PublicClientApplication } from '@azure/msal-node';
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from '@azure/msal-node-extensions';
import { getMicrosoftConfiguration, microsoftGraphScopes } from '../../communications/config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function resolveMicrosoftTokenPath(repositoryRoot = projectRoot) {
    if (typeof repositoryRoot !== 'string' || !path.isAbsolute(repositoryRoot)) {
        throw new TypeError('microsoft_repository_root_must_be_absolute');
    }
    return path.join(repositoryRoot, 'data', 'microsoft-token.json');
}
export const microsoftTokenPath = resolveMicrosoftTokenPath(projectRoot);

export class MicrosoftAuthError extends Error {
    constructor(code, message) { super(message); this.name = 'MicrosoftAuthError'; this.code = code; }
}

export function microsoftAuthorizationPage(state) {
    const content = {
        success: { title: 'Microsoft conectado', heading: 'Microsoft conectado', copy: 'Nexa ya puede usar la conexión autorizada. Volvé a Nexa para continuar.', mark: '✓' },
        cancelled: { title: 'Conexión cancelada', heading: 'Conexión cancelada', copy: 'No se completó la conexión. Volvé a Nexa si querés intentarlo de nuevo.', mark: '↩' },
        failed: { title: 'No se pudo conectar', heading: 'No se pudo conectar con Microsoft', copy: 'La conexión no se completó. Volvé a Nexa para revisar el estado e intentarlo de nuevo.', mark: '!' },
    }[state] ?? { title: 'No se pudo conectar', heading: 'No se pudo conectar con Microsoft', copy: 'La conexión no se completó. Volvé a Nexa para revisar el estado e intentarlo de nuevo.', mark: '!' };
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>${content.title} · Nexa</title><style>:root{color-scheme:dark;font-family:Segoe UI,Inter,Arial,sans-serif;background:#050b17;color:#e8f5ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% 0%,rgba(17,108,183,.28),transparent 55%),linear-gradient(145deg,#071326,#030711)}main{width:min(480px,100%);padding:34px;border:1px solid rgba(92,190,255,.35);border-radius:18px;background:rgba(8,20,39,.9);box-shadow:0 22px 70px rgba(0,0,0,.5),0 0 34px rgba(36,164,255,.12);text-align:center}mark{display:grid;place-items:center;width:54px;height:54px;margin:0 auto 20px;border:1px solid rgba(79,221,255,.5);border-radius:50%;background:rgba(27,132,189,.2);color:#71e4ff;font-size:24px}small{color:#75dfff;font-weight:700;letter-spacing:.2em;text-transform:uppercase}h1{margin:12px 0;color:#f3faff;font-size:25px;line-height:1.2}p{margin:0;color:#b6cce1;font-size:15px;line-height:1.65}</style></head><body><main><mark aria-hidden="true">${content.mark}</mark><small>Nexa · Microsoft</small><h1>${content.heading}</h1><p>${content.copy}</p></main></body></html>`;
}

function launchSystemBrowser(url) {
    let authorizationUrl;
    try { authorizationUrl = new URL(url); } catch { authorizationUrl = null; }
    if (process.platform !== 'win32' || authorizationUrl?.protocol !== 'https:' || authorizationUrl?.hostname !== 'login.microsoftonline.com') {
        throw new MicrosoftAuthError('microsoft_browser_unavailable', 'No se pudo abrir el navegador seguro de Microsoft en este sistema.');
    }
    return new Promise((resolve, reject) => {
        const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', () => reject(new MicrosoftAuthError('microsoft_browser_unavailable', 'No se pudo abrir el navegador para iniciar sesión.')));
        child.once('spawn', () => { child.unref(); resolve(); });
    });
}

export function createMicrosoftAuth({ environment = process.env, tokenPath = microsoftTokenPath,
    persistenceFactory = config => PersistenceCreator.createPersistence(config),
    clientFactory = config => new PublicClientApplication(config),
    cachePluginFactory = persistence => new PersistenceCachePlugin(persistence), browserOpener = launchSystemBrowser } = {}) {
    let clientPromise;
    let resolvedTokenPath = tokenPath;
    function configureCachePath(absolutePath) {
        if (clientPromise) throw new MicrosoftAuthError('microsoft_auth_already_initialized', 'La ruta de sesión Microsoft ya está en uso.');
        if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) throw new TypeError('microsoft_cache_path_must_be_absolute');
        resolvedTokenPath = absolutePath;
        return resolvedTokenPath;
    }
    function getConfiguration() {
        const config = getMicrosoftConfiguration(environment);
        if (!config.success) throw new MicrosoftAuthError(config.error.code, config.error.message);
        return config;
    }
    async function getClient() {
        if (!clientPromise) {
            clientPromise = (async () => {
                const config = getConfiguration();
                try {
                    const persistence = await persistenceFactory({ cachePath: resolvedTokenPath,
                        dataProtectionScope: DataProtectionScope.CurrentUser, serviceName: 'NexaMicrosoftAuth',
                        accountName: 'Nexa', usePlaintextFileOnLinux: false });
                    return clientFactory({ auth: { clientId: config.clientId, authority: config.authority },
                        cache: { cachePlugin: cachePluginFactory(persistence) },
                        system: { loggerOptions: { piiLoggingEnabled: false, logLevel: 0 } } });
                } catch (error) {
                    const isDpapiFailure = /dpapi|data protection/iu.test(String(error?.message ?? error?.code ?? ''));
                    throw new MicrosoftAuthError(isDpapiFailure ? 'microsoft_dpapi_unavailable' : 'microsoft_token_storage_unavailable',
                        isDpapiFailure ? 'Windows no pudo abrir el almacenamiento protegido de autorización Microsoft.' : 'No se pudo preparar el almacenamiento protegido de autorización Microsoft.');
                }
            })().catch(error => { clientPromise = undefined; throw error; });
        }
        return clientPromise;
    }
    async function getAccessToken() {
        try {
            const client = await getClient();
            const accounts = await client.getTokenCache().getAllAccounts();
            if (!accounts.length) return null;
            const result = await client.acquireTokenSilent({ account: accounts[0], scopes: [...microsoftGraphScopes] });
            return result?.accessToken ?? null;
        } catch (error) {
            if (error instanceof MicrosoftAuthError) throw error;
            const interactionRequired = typeof error?.errorCode === 'string' && /interaction_required|consent_required/iu.test(error.errorCode);
            throw new MicrosoftAuthError(interactionRequired ? 'microsoft_authorization_required' : 'microsoft_authentication_failed',
                interactionRequired ? 'La sesión Microsoft necesita reconectarse. Ejecutá npm run connect:microsoft.' : 'No se pudo obtener una sesión Microsoft válida.');
        }
    }
    async function connect() {
        try {
            const client = await getClient();
            const result = await client.acquireTokenInteractive({ scopes: [...microsoftGraphScopes], prompt: 'select_account',
                openBrowser: browserOpener, preferredPort: 0,
                successTemplate: microsoftAuthorizationPage('success'),
                errorTemplate: microsoftAuthorizationPage('failed') });
            return { success: true, account: { username: result?.account?.username ?? null } };
        } catch (error) {
            if (error instanceof MicrosoftAuthError) return { success: false, error: { code: error.code, message: error.message } };
            const failureDetails = [error?.errorCode, error?.subError, error?.message].filter(value => typeof value === 'string').join(' ');
            if (/user_cancelled|user_canceled|authentication_canceled|authentication_cancelled/iu.test(failureDetails)) {
                return { success: false, error: { code: 'microsoft_authorization_cancelled', message: 'La autorización de Microsoft fue cancelada.' } };
            }
            const consentBlocked = /consent_required|admin.?consent|aadsts65001|approval.{0,40}required/iu.test(failureDetails);
            return { success: false, error: { code: consentBlocked ? 'microsoft_admin_consent_required' : 'microsoft_authorization_failed',
                message: consentBlocked ? 'La política del tenant exige aprobación del administrador para estos permisos delegados.' : 'Microsoft no completó la autorización. Revisá el registro de aplicación, permisos delegados y URI local en Entra ID.' } };
        }
    }
    return { connect, getAccessToken, getConfiguration, configureCachePath };
}

export const microsoftAuth = createMicrosoftAuth();
