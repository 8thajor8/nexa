export const forgetTool = {
    type: 'function',
    name: 'forget',
    description: 'Elimina un recuerdo por su categoría y clave exactas. Usala solo cuando el usuario pida olvidar esa información.',
    parameters: {
        type: 'object',
        properties: {
            category: {
                type: 'string',
                enum: ['fact', 'preference', 'person', 'project', 'routine'],
                description: 'Categoría usada al guardar el recuerdo.',
            },
            key: {
                type: 'string',
                description: 'Clave exacta del recuerdo que se quiere eliminar.',
            },
        },
        required: ['category', 'key'],
        additionalProperties: false,
    },
    strict: true,
};

async function forget({ memory, args, saveMemory }) {
    const { category, key } = args;
    let removed = false;

    if (category === 'fact') {
        const index = (memory.facts ?? []).findIndex(item => item.key === key);

        if (index !== -1) {
            memory.facts.splice(index, 1);
            removed = true;
        }
    } else if (memory[category] && Object.hasOwn(memory[category], key)) {
        delete memory[category][key];
        removed = true;
    }

    if (!removed) {
        return {
            success: false,
            message: `No encontré un recuerdo con la categoría ${category} y la clave ${key}.`,
        };
    }

    await saveMemory(memory);

    return {
        success: true,
        message: `Recuerdo eliminado: ${key}`,
    };
}

export const forgetRegistration = {
    definition: forgetTool,
    execute: forget,
};
