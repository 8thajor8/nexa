# MEMORY-RUNTIME-READ1 — Fachada read-only de Memory2

## Interfaz

`src/memory/read-only.js` exporta `createMemory2ReadOnly({ repository })`. La fachada devuelve únicamente:

- `readContext({ message = "", recentUserMessages = [] } = {})`, que delega al `read()` de `createMemoryContextProvider()` y conserva su resultado `{ revision, digest, generation, items }`, incluidos los tipos de `items`.
- `close()`, que cierra la fachada local para nuevas lecturas.

El `repository` es inyectado y sigue siendo propiedad del caller. `close()` no lo cierra ni toma propiedad de su ciclo de vida; el propietario debe cerrar el repositorio por separado.

Los errores de lectura se sustituyen por `Memory2ReadOnlyError` con códigos estables `memory_read_failed` o `memory_facade_closed`. No se conservan causas, rutas, mensajes del sistema de archivos ni stack traces en el error público.

## Aislamiento y uso

Esta versión no está conectada a Runtime, agente, CLI, Electron ni herramientas. El punto de importación para una integración futura es `src/memory/read-only.js`; este batch no modifica ningún caller. No cambia `config.js`: si `NEXA_MEMORY_BACKEND` no está definido, Memory1 continúa siendo el backend predeterminado.

Las pruebas inyectan un repositorio sintético en memoria con una fixture Schema v5 validada. No abren, inicializan ni escriben en almacenes del usuario. La fachada no llama a `commit()` ni a ningún mutador.

La fachada limita la API accidentalmente expuesta por este objeto, pero no constituye una frontera de seguridad frente a código malicioso dentro del mismo proceso, que pudiera conservar referencias directas al repository o al archivo. El caller mantiene la responsabilidad de autorizar el acceso, aislar el repositorio y cerrarlo.
