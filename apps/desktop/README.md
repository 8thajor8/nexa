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
- src/renderer: composición React y tokens visuales Tailwind/CSS. `components/WindowChrome.tsx` contiene los controles accesibles de la ventana frameless; `components/Sidebar.tsx`, `ConversationPanel.tsx` y `PresencePanel.tsx` forman la navegación, el espacio central y el slot independiente del renderizador Presence; `data/command-center-mock.ts` contiene los mensajes de demostración.
- src/shared: estados simulados, contratos de ping/wallpaper e invariantes de confianza IPC.
- test: pruebas de contratos, estados y configuración de seguridad.
- scripts/dev.mjs: inicia Vite en loopback y Electron en desarrollo sin cambiar scripts del paquete principal.

Command Center muestra conversaciones de ejemplo identificadas como mock y una entrada deshabilitada para preparar UI-02.2. El panel Nexa Presence reserva un slot de renderizador para Presence Síntesis C-4, sin avatar ni contenido 3D. La navegación futura permanece deshabilitada. El botón técnico de ping prueba únicamente el IPC local. No conecta OpenAI, Memory, herramientas reales, Presence, Core ni System.

El layout usa una columna de navegación, el espacio central y un panel Presence en pantallas amplias. Al reducir el ancho, la navegación se contrae a iconos y Presence pasa debajo de la conversación; en ventanas estrechas, la navegación pasa a una barra superior y el contenido se apila sin exigir un ancho mínimo al documento.

La ventana de Windows es frameless y conserva los límites de redimensionamiento, minimizar, maximizar/restaurar y cerrar. Una franja superior dedicada se puede arrastrar; sus tres botones están marcados `no-drag`. Los controles usan canales IPC explícitos validados contra el frame principal. No hay menú nativo ni transparencia real de la ventana.

## Seguridad

BrowserWindow establece contextIsolation, sandbox y webSecurity en true, y nodeIntegration y allowRunningInsecureContent en false. El preload solo expone ping, lectura del wallpaper y tres operaciones de ventana específicas. Los handlers validan que el emisor sea el frame principal de Nexa; los canales de minimize/close descartan silenciosamente emisores no confiables. Se bloquean navegación fuera del punto de entrada, ventanas secundarias y webviews.

La política CSP de producción solo permite recursos locales e imágenes `data:` validadas por el preload. En desarrollo agrega únicamente el servidor Vite en 127.0.0.1:5173 y su WebSocket; permite scripts y estilos inline para el preámbulo de React Refresh y el HMR local. Nunca habilita unsafe-eval.

La selección del renderer usa `app.isPackaged` como criterio principal. Una app empaquetada ignora `VITE_DEV_SERVER_URL` y carga siempre `dist/index.html`. En una ejecución no empaquetada, la variable solo acepta `http://127.0.0.1:5173` (también con `/` final), sin credenciales, rutas, parámetros ni fragmentos; cualquier otro valor detiene el arranque. `npm start` ejecuta la compilación sin empaquetar: si la variable no está definida, carga el `dist/index.html` local; si está definida, solo puede apuntar al Vite local exacto.

## Wallpaper local de Windows

Al iniciar, el renderer solicita el wallpaper mediante el canal IPC explícito `nexa:wallpaper:get`. El proceso principal solo comprueba el archivo cacheado `Microsoft/Windows/Themes/TranscodedWallpaper` dentro de `app.getPath("appData")`; no recibe rutas desde el renderer, no consulta otras ubicaciones y no ejecuta procesos ni comandos del sistema. Solo admite archivos regulares, no enlaces simbólicos, de hasta 10 MiB, y verifica la firma de JPEG, PNG, WebP o BMP antes de convertirlos a un `data:` URL.

El preload valida el formato y tamaño del resultado antes de exponerlo. La respuesta no incluye rutas ni capacidades de lectura. La imagen se mantiene en memoria del renderer, no se persiste ni se envía a servicios externos. El toggle está activo por defecto; “Actualizar” vuelve a leer el archivo cacheado. Si no está disponible o no es un formato permitido, se conserva el fondo Nexa habitual. Una sola imagen cubre el shell; los paneles usan superficies azules translúcidas y backdrop blur sin desenfocar el contenido. No activa transparencia real de Electron.

## Fuera del alcance

No hay instalador, empaquetado de distribución, transparencia real, always-on-top, acceso al wallpaper original fuera de la caché de Windows ni conexión al motor Nexa.
