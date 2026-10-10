import 'dotenv/config';
import { closeDirectUserInput } from './core/direct-user-input.js';

import { createCliAgent } from './core/cli-agent.js';
import { config } from './config.js';
import { formatAutomaticMemoryAssessment } from './memory/automatic/assessment-presentation.js';
import { closeWhatsAppBrowser } from './integrations/whatsapp/bridge/session.js';
import { closeSpeechService, initializeSpeechService } from './speech/service.js';

let nexa;
try {
    await initializeSpeechService();
    nexa = await createCliAgent();
    console.log(`Nexa memory backend: ${config.cliMemoryMode ?? nexa.memoryBackend}`);
    console.log('');
    console.log('╔══════════════════════════════════╗');
    console.log('║          NEXA ONLINE             ║');
    console.log('╚══════════════════════════════════╝');
    console.log('');
    console.log('Escribí "salir" para terminar.');
    console.log('');

    while (true) {
        try {
            const turn = await nexa.readAndRun();
            if (turn.done) break;
            const response = turn.response;
            if (response) {
                console.log(`Nexa > ${response}`);
                console.log('');
            }
            // Assessment remains hard-disabled in the personal CLI until a later approval.
            const assessment = await nexa.completePresentedTurn();
            for (const line of formatAutomaticMemoryAssessment(assessment)) console.log(line);
        } catch (error) {
            console.error('Nexa ERROR >', error.message);
            console.log('');
        }
    }
} catch (error) {
    console.error('Nexa startup/runtime failure:', error.message);
    process.exitCode = 1;
} finally {
    closeDirectUserInput();
    for (const [name, close] of [['Memory', () => nexa?.close()],
        ['WhatsApp', closeWhatsAppBrowser], ['speech', closeSpeechService]]) {
        try { await close(); }
        catch (error) { console.error(`Nexa ${name} shutdown failure:`, error.message); process.exitCode = 1; }
    }
}
