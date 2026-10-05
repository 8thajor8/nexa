import { resolveAppInCatalog } from './app-catalog.js';
import { isTrustedAppPath } from './app-discovery.js';
import { isSafeAppUserModelId } from './appx-discovery.js';

export function resolveApp(catalog, requestedName, environment = process.env) {
    const result = resolveAppInCatalog(catalog, requestedName);
    if (result.status !== 'found') return result;

    const app = result.app;
    if (app.source === 'appx') {
        if (app.launchable !== true || !isSafeAppUserModelId(app.appUserModelId)) {
            return { status: 'invalid_target', app: null, matches: [] };
        }
        return { ...result, targetType: 'appx' };
    }

    if (!isTrustedAppPath(app.path, environment)) {
        return { status: 'invalid_target', app: null, matches: [] };
    }
    return { ...result, targetType: 'shortcut' };
}
