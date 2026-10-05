import { openWhatsAppChat } from './navigation.js';
import { prepareWhatsAppMessage } from './composer.js';

function functionTool(name, description, properties) {
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

const contactProperty = {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'Nombre exacto o distintivo del contacto de WhatsApp.',
};

export const whatsappOpenChatTool = functionTool(
    'whatsapp_open_chat',
    'Abre WhatsApp, busca un contacto, abre el chat y verifica el encabezado accesible. No envía mensajes.',
    { contact: contactProperty },
);

export const whatsappPrepareMessageTool = functionTool(
    'whatsapp_prepare_message',
    'Abre y verifica el chat indicado, comprueba que el campo esté vacío y deja el mensaje como borrador. Nunca pulsa Enviar ni envía el mensaje.',
    {
        contact: contactProperty,
        message: { type: 'string', minLength: 1, maxLength: 2000, description: 'Texto que se dejará como borrador, sin enviarlo.' },
    },
);

export const whatsappRegistrations = [
    {
        definition: whatsappOpenChatTool,
        execute: async ({ args } = {}) => {
            const opened = await openWhatsAppChat(args?.contact);
            if (opened?.result) return opened.result;
            return { success: true, completed: true, contact: opened.contact, chatOpened: true, sent: false };
        },
    },
    { definition: whatsappPrepareMessageTool, execute: prepareWhatsAppMessage },
];
