import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PublicClientApplication } from '@azure/msal-node';
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from '@azure/msal-node-extensions';
import { getMicrosoftConfiguration, microsoftGraphScopes } from '../../communications/config.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const microsoftTokenPath = path.join(projectRoot, 'data', 'microsoft-token.json');

export class MicrosoftAuthError extends Error {
    constructor(code, message) { super(message); this.name = 'MicrosoftAuthError'; this.code = code; }
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
                    const persistence = await persistenceFactory({ cachePath: tokenPath,
                        dataProtectionScope: DataProtectionScope.CurrentUser, serviceName: 'NexaMicrosoftAuth',
                        accountName: 'Nexa', usePlaintextFileOnLinux: false });
                    return clientFactory({ auth: { clientId: config.clientId, authority: config.authority },
                        cache: { cachePlugin: cachePluginFactory(persistence) },
                        system: { loggerOptions: { piiLoggingEnabled: false, logLevel: 0 } } });
                } catch {
                    throw new MicrosoftAuthError('microsoft_token_storage_unavailable', 'No se pudo preparar el almacenamiento protegido de autorización Microsoft.');
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
                successTemplate: '<h1>Nexa quedó conectada con Microsoft.</h1><p>Podés cerrar esta pestaña y volver a la terminal.</p>',
                errorTemplate: '<h1>No se pudo completar la conexión de Nexa.</h1><p>Volvé a la terminal para ver una explicación segura del error.</p>' });
            return { success: true, account: { username: result?.account?.username ?? null } };
        } catch (error) {
            if (error instanceof MicrosoftAuthError) return { success: false, error: { code: error.code, message: error.message } };
            const failureDetails = [error?.errorCode, error?.subError, error?.message].filter(value => typeof value === 'string').join(' ');
            const consentBlocked = /consent_required|admin.?consent|aadsts65001|approval.{0,40}required/iu.test(failureDetails);
            return { success: false, error: { code: consentBlocked ? 'microsoft_admin_consent_required' : 'microsoft_authorization_failed',
                message: consentBlocked ? 'La política del tenant exige aprobación del administrador para estos permisos delegados.' : 'Microsoft no completó la autorización. Revisá el registro de aplicación, permisos delegados y URI local en Entra ID.' } };
        }
    }
    return { connect, getAccessToken, getConfiguration };
}

export const microsoftAuth = createMicrosoftAuth();
