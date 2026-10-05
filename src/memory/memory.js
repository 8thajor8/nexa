import fs from 'node:fs/promises';
import path from 'node:path';

const memoryPath = path.resolve('data/memory.json');

export async function loadMemory() {
    try {
        const content = await fs.readFile(memoryPath, 'utf8');
        return JSON.parse(content);
    } catch (error) {
        return {
            user: {},
            preferences: {},
            facts: [],
        };
    }
}

export async function saveMemory(memory) {
    await fs.writeFile(
        memoryPath,
        JSON.stringify(memory, null, 2),
        'utf8'
    );
}

export function memoryToPrompt(memory) {
    return JSON.stringify(memory, null, 2);
}