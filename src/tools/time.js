export const getCurrentTimeTool = {
    type: 'function',
    name: 'get_current_time',
    description: 'Obtiene la fecha y hora actual del ordenador donde se ejecuta Nexa.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
    },
    strict: true,
};

async function getCurrentTime() {
    const now = new Date();

    return {
        iso: now.toISOString(),
        local: now.toString(),
        timestamp: now.getTime(),
    };
}

export const getCurrentTimeRegistration = {
    definition: getCurrentTimeTool,
    execute: getCurrentTime,
};
