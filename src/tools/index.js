import { getCurrentTimeRegistration } from './time.js';
import { rememberRegistration } from './remember.js';
import { recallRegistration } from './recall.js';
import { forgetRegistration } from './forget.js';
import { getWeatherRegistration } from './weather.js';
import { spotifyRegistrations } from './spotify.js';
import { whatsappRegistrations } from '../integrations/whatsapp/index.js';
import { speechRegistrations } from '../speech/index.js';
import { communicationsRegistrations } from '../communications/tools.js';
import {
    closeWindowRegistration,
    focusWindowRegistration,
    getActiveWindowRegistration,
    isAppRunningRegistration,
    listWindowsRegistration,
    maximizeWindowRegistration,
    minimizeWindowRegistration,
    restoreWindowRegistration,
} from '../windows/window-control.js';
import { discoverAppsRegistration } from '../windows/app-discovery.js';
import { uiAutomationRegistrations } from '../windows/ui-automation/index.js';
import { listDirectoryRegistration, readFileRegistration } from '../windows/filesystem.js';
import {
    getVolumeRegistration,
    mediaPlayPauseRegistration,
    muteVolumeRegistration,
    setVolumeRegistration,
    unmuteVolumeRegistration,
} from '../windows/audio.js';
import {
    getOpenAppsRegistration,
    openAppRegistration,
    openUrlRegistration,
} from './windows.js';
import {
    checkToolPermission,
    defaultPermissionPolicy,
    toolPermissions,
} from './permissions.js';

const localRegistrations = [
    getCurrentTimeRegistration,
    rememberRegistration,
    recallRegistration,
    forgetRegistration,
    getWeatherRegistration,
    discoverAppsRegistration,
    openAppRegistration,
    openUrlRegistration,
    getOpenAppsRegistration,
    listDirectoryRegistration,
    readFileRegistration,
    getVolumeRegistration,
    setVolumeRegistration,
    muteVolumeRegistration,
    unmuteVolumeRegistration,
    mediaPlayPauseRegistration,
    isAppRunningRegistration,
    getActiveWindowRegistration,
    listWindowsRegistration,
    focusWindowRegistration,
    maximizeWindowRegistration,
    minimizeWindowRegistration,
    restoreWindowRegistration,
    closeWindowRegistration,
    ...uiAutomationRegistrations,
    ...whatsappRegistrations,
    ...speechRegistrations,
    ...communicationsRegistrations,
    ...spotifyRegistrations,
].map(registration => ({
    ...registration,
    permission: toolPermissions[registration.definition.name],
}));

export const localToolRegistry = new Map(
    localRegistrations.map(registration => [registration.definition.name, registration])
);

export const localTools = [...localToolRegistry.values()].map(
    registration => registration.definition
);

export const hostedToolRegistry = [
    {
        definition: {
            type: 'web_search',
            user_location: {
                type: 'approximate',
                country: 'ES',
                city: 'Barcelona',
                region: 'Catalonia',
                timezone: 'Europe/Madrid',
            },
        },
        permission: toolPermissions.web_search,
    },
];

export const hostedTools = hostedToolRegistry.map(
    registration => registration.definition
);

// Memory1's legacy write tools are retired at the dispatcher boundary. Keep
// their registrations for compatibility, but never offer or execute them.
const disabledLegacyMemoryWriteTools = new Set(['remember', 'forget']);

export function getToolsForModel(policy = defaultPermissionPolicy) {
    const permittedLocalTools = localTools
        .filter(tool => !disabledLegacyMemoryWriteTools.has(tool.name));
    const permittedHostedTools = hostedToolRegistry
        .filter(registration => checkToolPermission(registration, policy).allowed)
        .map(registration => registration.definition);

    return [
        ...permittedLocalTools,
        ...permittedHostedTools,
    ];
}

export const tools = getToolsForModel();

export async function executeTool(name, args, context) {
    const registration = localToolRegistry.get(name);

    if (!registration) {
        throw new Error(`Herramienta desconocida: ${name}`);
    }

    if (disabledLegacyMemoryWriteTools.has(name)) {
        return {
            success: false,
            error: {
                code: 'memory1_write_disabled',
                message: 'Las escrituras heredadas de Memory1 están deshabilitadas; no se modificó ningún recuerdo.',
            },
            permission: registration.permission,
        };
    }

    const permission = checkToolPermission(registration, context?.permissionPolicy);

    if (!permission.allowed) {
        return {
            success: false,
            error: {
                code: permission.reason,
                message: `La política de permisos no permite ejecutar ${name}.`,
            },
            permission: permission.permission,
        };
    }

    return registration.execute({ ...context, args });
}
