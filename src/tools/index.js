import { getCurrentTimeRegistration } from './time.js';
import { rememberRegistration } from './remember.js';
import { recallRegistration } from './recall.js';
import { forgetRegistration } from './forget.js';
import { getWeatherRegistration } from './weather.js';
import { discoverAppsRegistration } from '../windows/app-discovery.js';
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

export function getToolsForModel(policy = defaultPermissionPolicy) {
    const permittedHostedTools = hostedToolRegistry
        .filter(registration => checkToolPermission(registration, policy).allowed)
        .map(registration => registration.definition);

    return [
        ...localTools,
        ...permittedHostedTools,
    ];
}

export const tools = getToolsForModel();

export async function executeTool(name, args, context) {
    const registration = localToolRegistry.get(name);

    if (!registration) {
        throw new Error(`Herramienta desconocida: ${name}`);
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
