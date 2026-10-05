import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const spotifyTokenPath = path.join(projectRoot, 'data', 'spotify-token.json');

export async function loadSpotifyTokens({ tokenPath = spotifyTokenPath } = {}) {
    try {
        const value = JSON.parse(await readFile(tokenPath, 'utf8'));
        if (!value || typeof value.refreshToken !== 'string' || !value.refreshToken) return null;
        return value;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

export async function saveSpotifyTokens(tokens, { tokenPath = spotifyTokenPath } = {}) {
    await mkdir(path.dirname(tokenPath), { recursive: true });
    const temporaryPath = `${tokenPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
    });
    await rename(temporaryPath, tokenPath);
}

export async function clearSpotifyTokens({ tokenPath = spotifyTokenPath } = {}) {
    const { unlink } = await import('node:fs/promises');
    try {
        await unlink(tokenPath);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}
