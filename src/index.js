import 'dotenv/config';
import { closeDirectUserInput } from './core/direct-user-input.js';

import { createAgent } from './core/agent.js';
import { closeWhatsAppBrowser } from './integrations/whatsapp/bridge/session.js';
import { closeSpeechService, initializeSpeechService } from './speech/service.js';

await initializeSpeechService();

const nexa = await createAgent();

console.log('');
console.log('╔══════════════════════════════════╗');
console.log('║          NEXA ONLINE             ║');
console.log('╚══════════════════════════════════╝');
console.log('');
console.log('Escribí "salir" para terminar.');
console.log('');

try {
    while (true) {
        try {
            const turn = await nexa.readAndRun();
            if (turn.done) break;
            const response = turn.response;
            if (!response) continue;

            console.log(`Nexa > ${response}`);
            console.log('');
        } catch (error) {
            console.error('Nexa ERROR >', error.message);
            console.log('');
        }
    }
} finally {
    closeDirectUserInput();
    await closeWhatsAppBrowser();
    await closeSpeechService();
}
