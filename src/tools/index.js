import { getCurrentTimeRegistration } from './time.js';
import { rememberRegistration } from './remember.js';
import { recallRegistration } from './recall.js';
import { forgetRegistration } from './forget.js';

export const localToolRegistry = new Map(
    [
        getCurrentTimeRegistration,
        rememberRegistration,
        recallRegistration,
        forgetRegistration,
    ].map(registration => [registration.definition.name, registration])
);

export const localTools = [...localToolRegistry.values()].map(
    registration => registration.definition
);

export const hostedTools = [
    {
        type: 'web_search',
        user_location: {
            type: 'approximate',
            country: 'ES',
            city: 'Barcelona',
            region: 'Catalonia',
            timezone: 'Europe/Madrid',
        },
    },
];

export const tools = [
    ...localTools,
    ...hostedTools,
];

export async function executeTool(name, args, context) {
    const registration = localToolRegistry.get(name);

    if (!registration) {
        throw new Error(`Herramienta desconocida: ${name}`);
    }

    return registration.execute({ ...context, args });
}
