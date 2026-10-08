# Automatic Memory C.5c — Integración controlada del extractor

## Estado

C.5c compone el adaptador real de extracción en el CLI, pero mantiene el análisis desactivado de forma fija. `src/index.js` crea el detector y lo inyecta con `enableAutomaticMemoryAssessment: false`. El CLI no ofrece una variable de entorno ni un argumento para habilitarlo. `createAgent()` también rechaza activar directamente el detector registrado como real. Por tanto esta composición no puede llamar a OpenAI durante el uso normal ni por una configuración incompleta.

La prueba de integración usa `createAutomaticMemoryDetector()` con una función de extracción simulada y un agente con backend Memory1. Comprueba el recorrido de `stdin`, consentimiento sintético, frontera, validación y policy. No usa el cliente HTTP ni una clave.

## Flujo implementado y validado

```text
stdin real
  → prueba opaca de turno/destinatario/texto
  → consentimiento y exclusiones vigentes
  → filtro de privacidad y comprobación de contaminación de sesión
  → detector inyectado (mock en pruebas; real compuesto pero hard-off en CLI)
  → validación estricta de schema/evidencia
  → policy determinista
  → resultado efímero de completePresentedTurn()
```

El extractor recibe solo `{ text, signal }` a través del detector; instrucciones fijas se agregan dentro del adaptador. La respuesta no confiable se valida de nuevo en la frontera. Los tests cubren salida válida, candidato con `user` sin Self canónico (permanece en `ask` con Memory1), timeout, cancelación, salida tardía, exclusión y rechazo seguro. Los resultados no incluyen autorización y declaran `authorizationGranted: false`, `writeReady: false` y `persisted: false`.

La marca de exposición C.5b sigue bloqueando toda la instancia después de una respuesta de tool, memoria recuperada o una evaluación que llegó al extractor. Una nueva instancia con contexto vacío obtiene una frontera nueva; no existe un mecanismo para limpiar la marca dentro de la sesión contaminada. No se confía en una evaluación del modelo para detectar paráfrasis.

## Revisión y propuestas

La llamada de `completePresentedTurn()` devuelve candidatos efímeros y el CLI los presenta después de imprimir la respuesta. Solo muestra decisiones `ask`/`auto_save`; omite `ignore`/`duplicate`, redacta propuestas sensibles o con aspecto de secreto y limita/limpia el texto para terminal. El encabezado aclara que no se guardó ningún recuerdo. No se llama a la cola persistente. La cola existente solo acepta acciones `ADD`/`REPLACE`, mientras que sin snapshot canónico (Memory1 sigue activo) el sujeto Self queda sin resolver y la policy produce `ask`; un REPLACE tampoco puede inventar un target. Forzar esos candidatos a `ADD` o `REPLACE` sería una representación falsa. Cualquier futura adaptación deberá conservar `ask`, el target exacto de REPLACE y los filtros de contenido de la cola, sin convertir aprobación de revisión en autorización de escritura.

La propuesta no se persiste en Memory1, Memory2 ni en la cola local. La presentación dura solo mientras se procesa el resultado en memoria; las pruebas confirman cero llamadas a `enqueue()` y cero escrituras. La opción de persistir resúmenes en el futuro requeriría una decisión separada de retención local.

## Activación y privacidad

- El detector real se compone detrás de un switch literal `false`; no hay `--live` ni flag de CLI en este flujo.
- No se hicieron llamadas a OpenAI. `tools: []`, `store: false`, schema estricto, límite de tokens y `AbortSignal` permanecen en el adaptador.
- No se inspeccionaron credenciales ni la configuración efectiva de organización/proyecto.
- `store: false` no demuestra retención cero. Antes de una primera llamada real, el usuario debe verificar en el panel el proyecto, la política de retención y elegibilidad de ZDR/MAM, y aceptar el tratamiento aplicable.
- El consentimiento local para analizar no concede permiso para persistir. Guardado automático permanece desactivado.
- Memory1 sigue siendo el backend efectivo; no se crea ni migra un store Memory2 personal.

## Evidencia y límites

La prueba C.5c usa el adaptador real con `extractCandidates` falso y comprueba que el texto transmitido es exactamente el turno de `stdin`, que la decisión pasa por la policy y que no se llama a la cola ni a `save`. Los tests de C.5a/C.5b cubren procedencia, contaminación, exclusiones, revocación, timeouts y respuestas tardías. Todas las respuestas y entradas son sintéticas.

Esto no mide calidad del modelo, comportamiento de red, retención real del proveedor ni independencia semántica entre sesiones. La cola no recibe propuestas del extractor y el detector real no puede habilitarse desde el CLI. No se activa aprendizaje ni se habilita uso personal.

## Pendiente antes de una prueba real

1. Revisar y aceptar la retención y tratamiento efectivos de la organización/proyecto OpenAI; no basta con `store: false`.
2. Aprobar por separado una primera llamada real, con corpus sintético y límite de llamadas/coste, y un mecanismo de activación explícito que no dependa de una configuración incompleta.
3. Conservar los controles C.5b y verificar una sesión fresca, con contexto vacío, antes de cualquier análisis.

C.5c no habilita extractor real, aprendizaje, escritura automática, activación personal de Memory2 ni migración.
