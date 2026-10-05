import OpenAI from 'openai';
import { config } from '../config.js';

let client;

function getClient() {
    if (!client) {
        client = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
        });
    }
    return client;
}

export async function askOpenAI({ instructions, input, tools = [] }) {
    return getClient().responses.create({
        model: config.model,
        instructions,
        input,
        tools,
    });
}
