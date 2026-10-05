import 'dotenv/config';
import { authorizeSpotify } from './auth.js';

try {
    await authorizeSpotify();
    console.log('Autorización completada. Nexa ya puede usar Spotify.');
} catch (error) {
    console.error(`No se pudo autorizar Spotify: ${error.message}`);
    process.exitCode = 1;
}
