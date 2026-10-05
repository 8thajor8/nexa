import 'dotenv/config';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { createAgent } from './core/agent.js';

const rl = readline.createInterface({
    input,
    output,
});

const nexa = await createAgent();

console.log('');
console.log('╔══════════════════════════════════╗');
console.log('║          NEXA ONLINE             ║');
console.log('╚══════════════════════════════════╝');
console.log('');
console.log('Escribí "salir" para terminar.');
console.log('');

while (true) {
    const message = await rl.question('Vos > ');

    if (message.trim().toLowerCase() === 'salir') {
        break;
    }

    if (!message.trim()) {
        continue;
    }

    try {
        const response = await nexa.run(message);

        console.log(`Nexa > ${response}`);
        console.log('');
    } catch (error) {
        console.error('Nexa ERROR >', error.message);
        console.log('');
    }
}

rl.close();