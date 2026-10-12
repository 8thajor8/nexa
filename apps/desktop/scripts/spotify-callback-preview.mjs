import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function buildSpotifyCallbackPreview(renderCallbackPage) {
    if (typeof renderCallbackPage !== 'function') throw new TypeError('callback_page_renderer_required');
    const states = [
        ['success', 'Éxito'],
        ['cancelled', 'Cancelación'],
        ['failed', 'Error'],
    ];
    const frames = states.map(([state, label]) => {
        const page = renderCallbackPage(state);
        const srcdoc = page.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        return `<section><h2>${label}</h2><iframe title="Callback Spotify: ${label}" sandbox srcdoc="${srcdoc}"></iframe></section>`;
    }).join('');
    return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Vista previa callback · Nexa</title><style>*{box-sizing:border-box}body{margin:0;padding:28px;background:#070d19;color:#e8f5ff;font:14px Segoe UI,Arial,sans-serif}h1{margin:0 0 22px;color:#80def5;font-size:20px}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:18px}section{min-width:0;padding:14px;border:1px solid #234361;border-radius:12px;background:#0b1728}h2{margin:0 0 12px;font-size:14px;font-weight:600}iframe{display:block;width:100%;height:340px;border:0;border-radius:8px;background:#050b17}@media(max-width:600px){body{padding:14px}iframe{height:300px}}</style></head><body><h1>Nexa · Vista previa de callback Spotify (sin autorización real)</h1><main>${frames}</main></body></html>`;
}

async function main() {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(scriptDir, '..', '..', '..');
    const { spotifyCallbackPage } = await import(pathToFileURL(join(repoRoot, 'src', 'integrations', 'spotify', 'auth.js')));
    const html = buildSpotifyCallbackPreview(spotifyCallbackPage);
    const directory = await mkdtemp(join(tmpdir(), 'nexa-spotify-callback-preview-'));
    const previewPath = join(directory, 'index.html');
    await writeFile(previewPath, html, { encoding: 'utf8', flag: 'wx' });
    console.log(`Vista previa generada: ${previewPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
