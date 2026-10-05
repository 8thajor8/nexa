import { askOpenAI } from '../brain/openai.js';
import { config } from '../config.js';
import { NEXA_INSTRUCTIONS } from '../prompts/nexa.js';
import { loadMemory, memoryToPrompt, saveMemory } from '../memory/memory.js';
import { getToolsForModel, executeTool } from '../tools/index.js';
import { formatSpotifyToolResult, isSpotifyTool, spotifyModelSafeOutput } from '../tools/spotify.js';

export async function createAgent({ permissionPolicy } = {}) {
    const memory = await loadMemory();

    function getInstructions() {
        return `
${NEXA_INSTRUCTIONS}

MEMORIA ACTUAL DEL USUARIO:
${memoryToPrompt(memory)}
`;
    }

    const conversation = [];

    async function run(userMessage) {
        const spotifyMessages = [];
        conversation.push({
            role: 'user',
            content: userMessage,
        });

        for (let iteration = 0; iteration < config.maxToolIterations; iteration++) {
            const response = await askOpenAI({
                instructions: getInstructions(),
                input: conversation,
                tools: getToolsForModel(permissionPolicy),
            });

            conversation.push(...response.output);

            const toolCalls = response.output.filter(
                item => item.type === 'function_call'
            );

            if (toolCalls.length === 0) {
                return [response.output_text, ...spotifyMessages].filter(Boolean).join('\n\n');
            }

            for (const toolCall of toolCalls) {
                const args = JSON.parse(toolCall.arguments);

                const result = await executeTool(
                    toolCall.name,
                    args,
                    {
                        memory,
                        saveMemory,
                        permissionPolicy,
                    }
                );

                const isSpotify = isSpotifyTool(toolCall.name);
                const output = isSpotify ? spotifyModelSafeOutput(toolCall.name, result) : result;
                if (isSpotify) spotifyMessages.push(formatSpotifyToolResult(toolCall.name, result));

                conversation.push({
                    type: 'function_call_output',
                    call_id: toolCall.call_id,
                    output: JSON.stringify(output),
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
