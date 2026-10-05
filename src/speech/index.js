import { generateSpeech, playAudio } from './service.js';

function speechTool(name, description, properties) {
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        },
        strict: true,
    };
}

export const generateSpeechTool = speechTool(
    'generate_speech',
    'Genera un audio de voz Nexa. Elegí solo un estilo enumerado. persist=false crea un audio temporal; no reproduce automáticamente.',
    {
        text: { type: 'string', minLength: 1, maxLength: 3000, description: 'Texto que se va a pronunciar.' },
        style: { type: 'string', enum: ['normal', 'professional', 'alert', 'sassy', 'calm'], description: 'Estilo de interpretación; normal si el usuario no especificó uno.' },
        persist: { type: 'boolean', description: 'true conserva el archivo localmente; false lo elimina después de reproducir o al cerrar Nexa.' },
    },
);

export const playAudioTool = speechTool(
    'play_audio',
    'Reproduce en Windows un audio generado por Nexa usando su audioId registrado. No acepta rutas.',
    { audioId: { type: 'string', pattern: '^audio_[a-f0-9]{24}$', description: 'Identificador devuelto por generate_speech.' } },
);

export const speechRegistrations = [
    {
        definition: generateSpeechTool,
        execute: async ({ args } = {}) => generateSpeech({
            text: args?.text,
            style: args?.style === undefined ? 'normal' : args.style,
            persist: args?.persist === undefined ? false : args.persist,
        }),
    },
    {
        definition: playAudioTool,
        execute: async ({ args } = {}) => playAudio(args?.audioId),
    },
];
