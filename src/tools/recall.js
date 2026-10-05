export const recallTool = {
    type: 'function',
    name: 'recall',
    description: 'Busca información que Nexa haya guardado previamente sobre el usuario.',
    parameters: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Qué información se quiere recordar o buscar.',
            },
        },
        required: ['query'],
        additionalProperties: false,
    },
    strict: true,
};

async function recall({ memory, args }) {
    const query = args.query.toLowerCase();

    const results = [];

    // Buscar en facts
    for (const fact of memory.facts ?? []) {
        const text = `${fact.key} ${fact.value}`.toLowerCase();

        if (text.includes(query)) {
            results.push({
                category: 'fact',
                key: fact.key,
                value: fact.value,
            });
        }
    }

    // Buscar en el resto de categorías
    for (const [category, values] of Object.entries(memory)) {
        if (category === 'facts' || typeof values !== 'object') {
            continue;
        }

        for (const [key, value] of Object.entries(values)) {
            const text = `${key} ${value}`.toLowerCase();

            if (text.includes(query)) {
                results.push({
                    category,
                    key,
                    value,
                });
            }
        }
    }

    return {
        success: true,
        results,
    };
}

export const recallRegistration = {
    definition: recallTool,
    execute: recall,
};
