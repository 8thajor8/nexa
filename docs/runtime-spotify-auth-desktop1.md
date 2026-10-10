# Runtime Spotify Authorization for Desktop Main

Runtime exposes a local authorization interface for Electron Main in
`src/integrations/spotify/authorization-runtime.js`. Instantiate it only in the
Electron **main process**. Do not import it in Renderer or expose tokens,
verifiers, or callback parameters over IPC.

```js
import { shell } from 'electron';
import { createSpotifyAuthorizationRuntime } from './src/integrations/spotify/authorization-runtime.js';

const spotifyAuthorization = createSpotifyAuthorizationRuntime();

const initialStatus = await spotifyAuthorization.getStatus();
// Send only the status object to the UI.

// Call this only after an explicit user action.
const flow = await spotifyAuthorization.startAuthorization();
if (flow.authorizationUrl) {
    await shell.openExternal(flow.authorizationUrl);
    const result = await flow.completion;
    // Send only result.status and result.error to the UI.
}

// A user cancel action calls flow.cancel(). On app shutdown:
await spotifyAuthorization.close();
```

## Contract

`getStatus()` resolves to one of:

- `{ status: 'connected' }`
- `{ status: 'not_connected' }`
- `{ status: 'reauthorization_required', error: { code, message } }`
- `{ status: 'error', error: { code, message } }`

Status checks reuse a valid access token and refresh an expired token when
possible. They never initiate OAuth. Refresh requests are made only when the
stored access token is expired or forced by Spotify rejecting a request.

`startAuthorization({ force = false })` must follow an explicit UI action. If
the session is already valid and `force` is false, it returns
`{ authorizationUrl: null, alreadyConnected: true, completion, cancel }` and
does not reauthorize. Otherwise it starts a temporary loopback PKCE callback
and returns `{ authorizationUrl, alreadyConnected: false, completion, cancel }`.
The URL is generated with a fresh verifier, challenge, and state for each flow.
`completion` resolves to `{ status: 'connected' }`, `{ status: 'cancelled' }`,
or `{ status: 'error', error: { code, message } }`. Only one flow may be active
per process. Cancellation is cooperative; once the callback has begun token
exchange, `cancel()` returns false because the exchange cannot safely be
rolled back.

Known start errors include `spotify_config_missing`,
`spotify_config_invalid`, `spotify_callback_unavailable`,
`spotify_authorization_in_progress`, and `spotify_runtime_closed`.
Messages are fixed/sanitized; they do not include provider responses, tokens,
authorization codes, or callback URLs.

## Configuration and credential path

The runtime reads `SPOTIFY_CLIENT_ID` and `SPOTIFY_REDIRECT_URI` from the
provided environment. When using `process.env`, it loads `.env` from the Nexa
project root derived from the Runtime module location, so Electron's working
directory does not select a different file. The accepted callback remains
`http://127.0.0.1:8888/callback` and must match the Spotify application
configuration.

The default token store is the same `data/spotify-token.json` used by the CLI,
resolved from the package location rather than the process working directory.
Therefore CLI and Desktop processes using the same installed Nexa package can
reuse the same authorization. A separately packaged Desktop copy has a
different package root and will not automatically share the CLI file; do not
copy credentials through IPC. The existing token file is JSON credential
storage; Windows file mode flags do not by themselves guarantee a restrictive
Windows ACL, so a packaged app should coordinate a protected user-data store
before changing this path.

## Error handling

If Spotify API tools report `spotify_auth_required`, Main should show a
Connect Spotify action; it must not automatically call `startAuthorization()`
because the model requested a Spotify operation. If status is
`reauthorization_required`, offer the same explicit action. Tool errors remain
separate from the OAuth completion state.
