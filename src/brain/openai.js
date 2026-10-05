import OpenAI from 'openai';
import { config } from '../config.js';

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function askOpenAI({ instructions, input, tools = [] }) {
    return client.responses.create({
        model: config.model,
        instructions,
        input,
        tools,
    });
}