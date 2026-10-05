import OpenAI from 'openai';
import { config } from '../config.js';

let client;

export function getOpenAIClient() {
    if (!client) {
        client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }
    return client;
}

export async function askOpenAI({ instructions, input, tools = [] }) {
    return getOpenAIClient().responses.create({
        model: config.model,
        instructions,
        input,
        tools,
    });
}
