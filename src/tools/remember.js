export const rememberTool = {
    type: 'function',
    name: 'remember',
    description: 'Guarda información importante sobre el usuario para recordarla en futuras conversaciones.',
    parameters: {
        type: 'object',
        properties: {
            category: {
                type: 'string',
                enum: ['fact', 'preference', 'person', 'project', 'routine'],
                description: 'Categoría de la información.',
            },
            key: {
                type: 'string',
                description: 'Nombre corto que identifica el recuerdo.',
            },
            value: {
                type: 'string',
                description: 'Información que debe recordarse.',
            },
        },
        required: ['category', 'key', 'value'],
        additionalProperties: false,
    },
    strict: true,
};

async function remember({ memory, args, saveMemory }) {
    const { category, key, value } = args;

    if (category === 'fact') {
        const existing = memory.facts.find(
            item => item.key === key
        );

        if (existing) {
            existing.value = value;
        } else {
            memory.facts.push({
                key,
                value,
            });
        }
    } else {
        if (!memory[category]) {
            memory[category] = {};
        }

        memory[category][key] = value;
    }

    await saveMemory(memory);

    return {
        success: true,
        message: `Recuerdo guardado: ${key}`,
    };
}

export const rememberRegistration = {
    definition: rememberTool,
    execute: remember,
};
