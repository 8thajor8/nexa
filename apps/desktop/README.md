# Nexa Desktop

Aplicación de escritorio Windows mínima para la siguiente etapa de Nexa. Este paquete vive en apps/desktop y no modifica los scripts, dependencias ni la ejecución del núcleo Nexa.

## Requisitos y versiones elegidas

El entorno inspeccionado usa Node.js 22.14.0 y npm 10.9.2. Vite 8 requiere Node.js 20.19+ o 22.12+, por lo que la versión de Node del entorno cumple el mínimo.

Versiones directas fijadas para esta base:

- Electron 44.7.0
- React y React DOM 19.3.0
- Vite 8.3.4
- @vitejs/plugin-react 6.1.2
- Tailwind CSS y @tailwindcss/vite 4.3.3
- TypeScript 5.9.3
- Vitest 5.0.3
- esbuild 0.28.2
- Tipos TypeScript de Node 22 y React 19

El lockfile registra las versiones exactas resueltas para dependencias transitivas.

## Comandos

Ejecutar desde apps/desktop:

- Desarrollo con Vite y Electron: npm run dev
- Compilación y verificación TypeScript: npm run build
- Verificación TypeScript solamente: npm run typecheck
- Pruebas automatizadas: npm test
- Inicio de la compilación existente: npm start

npm start requiere ejecutar npm run build antes.

## Arquitectura

- src/main: proceso principal, creación y ciclo de vida de ventana, IPC y política de seguridad.
- src/preload.ts: API mínima expuesta por contextBridge; el bundle de preload se genera como CommonJS para el proceso renderer aislado y sandboxed.
- src/renderer: aplicación React y estilos Tailwind.
- src/shared: estados simulados, contrato de ping e invariantes de confianza IPC.
- test: pruebas de contratos, estados y configuración de seguridad.
- scripts/dev.mjs: inicia Vite en loopback y Electron en desarrollo sin cambiar scripts del paquete principal.

La pantalla confirma el estado local y permite probar una llamada ping/pong por IPC. No conecta OpenAI, Memory, herramientas reales, Presence, Core ni System.

## Seguridad

BrowserWindow establece contextIsolation, sandbox y webSecurity en true, y nodeIntegration y allowRunningInsecureContent en false. El preload valida la respuesta IPC y solo expone ping(). El handler valida que el emisor sea el frame principal de la ventana Nexa. Se bloquean navegación fuera del punto de entrada, ventanas secundarias y webviews.

La política CSP de producción solo permite recursos locales. En desarrollo agrega únicamente el servidor Vite en 127.0.0.1:5173 y su WebSocket; permite scripts y estilos inline para el preámbulo de React Refresh y el HMR local. Nunca habilita unsafe-eval.

La selección del renderer usa `app.isPackaged` como criterio principal. Una app empaquetada ignora `VITE_DEV_SERVER_URL` y carga siempre `dist/index.html`. En una ejecución no empaquetada, la variable solo acepta `http://127.0.0.1:5173` (también con `/` final), sin credenciales, rutas, parámetros ni fragmentos; cualquier otro valor detiene el arranque. `npm start` ejecuta la compilación sin empaquetar: si la variable no está definida, carga el `dist/index.html` local; si está definida, solo puede apuntar al Vite local exacto.

## Fuera del alcance

No hay instalador, empaquetado de distribución, transparencia real, always-on-top, recursos visuales finales ni conexión al motor Nexa.
