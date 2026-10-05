import { askOpenAI } from '../brain/openai.js';
import { config } from '../config.js';
import { NEXA_INSTRUCTIONS } from '../prompts/nexa.js';
import { loadMemory, memoryToPrompt, saveMemory } from '../memory/memory.js';
import { tools, executeTool } from '../tools/index.js';

export async function createAgent() {
    const memory = await loadMemory();

    const instructions = `
${NEXA_INSTRUCTIONS}

MEMORIA ACTUAL DEL USUARIO:
${memoryToPrompt(memory)}
`;

    const conversation = [];

    async function run(userMessage) {
        conversation.push({
            role: 'user',
            content: userMessage,
        });

        for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
            const response = await askOpenAI({
                instructions,
                input: conversation,
                tools,
            });

            conversation.push(...response.output);

            const toolCalls = response.output.filter(
                item => item.type === 'function_call'
            );

            if (toolCalls.length === 0) {
                return response.output_text;
            }

            for (const toolCall of toolCalls) {
                const args = JSON.parse(toolCall.arguments);

                const result = await executeTool(
                    toolCall.name,
                    args,
                    {
                        memory,
                        saveMemory,
                    }
                );

                conversation.push({
                    type: 'function_call_output',
                    call_id: toolCall.call_id,
                    output: JSON.stringify(result),
                });
            }
        }

        throw new Error(
            'Nexa alcanzó el límite de iteraciones de herramientas.'
        );
    }

    return {
        run,
        memory,
    };
}
