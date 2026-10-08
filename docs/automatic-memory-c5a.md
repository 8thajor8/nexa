# Automatic Memory C.5a — extractor aislado, procedencia y privacidad

## Estado

C.5a preparó una frontera de evaluación aislada y su contrato para el extractor Responses API. La implementación y el estado de integración posteriores quedan descritos en [Automatic Memory C.5b](./automatic-memory-c5b.md). C.5a no activa el extractor real, no realiza solicitudes a OpenAI, no escribe propuestas ni recuerdos y no consulta Memory1/Memory2.

Las observaciones y requisitos siguientes son una fotografía de C.5a antes de C.5b. Donde indiquen que la frontera no está conectada o que la capability caduca antes de `completePresentedTurn()`, prevalece el estado posterior documentado en C.5b.

El CLI sigue creando el agente sin un detector. El agente mantiene el hook experimental C.2, apagado por defecto, que solo funciona cuando el host inyecta un detector; ese hook recibe texto directo y una señal de cancelación, pero todavía no consume la capability de procedencia ni instala el seguimiento de exposiciones externas de C.5a. La fábrica marca en un registro privado del adaptador OpenAI al detector real por defecto y `createAgent()` lo rechaza en el hook C.2; la prueba usa la fábrica pero no realiza una solicitud. **No se debe envolver manualmente la función real para sortear este rechazo.** C.5b tendrá que reemplazar el hook por la frontera C.5a y resolver su ciclo de vida de capability antes de permitir análisis real.

`extractAutomaticMemoryProposal()` permanece exportada porque el harness de evaluación `--live` la utiliza bajo una compuerta explícita. La API de bajo nivel no es una frontera de seguridad para código confiable que importe módulos directamente: ningún modelo ni tool recibe esa referencia, y C.5a no se conecta al agente. La futura composición de producto debe mantener el extractor detrás de `assessment-boundary.js`; no debe pasar el helper ni un wrapper alrededor del detector a `createAgent()`.

## Arquitectura observada

- `src/core/direct-user-input.js` emite `runtimeContextCapability` al leer texto por el `stdin` real. `consumeTrustedLocalTurnContext()` lo consume una sola vez y valida destinatario, turno activo y SHA-256 del texto original. Un objeto con campos equivalentes no sirve. La prueba representa una sesión de runtime local, no la identidad humana autenticada de quien controla el proceso.
- `src/core/agent.js` mantiene consentimiento persistente, exclusión de conversación, exclusión por mensaje, un interruptor de análisis y un interruptor de guardado distinto. `automaticSavingEnabled` permanece desactivado; Memory2 retrieval está desactivado cuando el backend es Memory1.
- `src/memory/automatic/privacy.js` aplica el filtro previo de credenciales, ubicaciones, contenido temporal, citas/importaciones, datos protegidos e instrucciones maliciosas. Devuelve códigos fijos, no el texto bloqueado.
- `src/memory/automatic/detector.js` normaliza las propuestas. `src/brain/openai.js` usa Responses API, `tools: []`, Structured Outputs estrictos, `store: false` y una sola entrada con el turno dado. C.5a añade el forwarding de `AbortSignal` para cancelación del SDK.
- `src/memory/automatic/assessment-boundary.js` consume por sí misma la capability de `stdin`, comprueba el consentimiento y los controles, aplica el filtro, consulta el marcador de contexto no confiable, limita la espera y vuelve a validar la salida con schema y policy. No importa agente, tools, historial, memoria, cola, servicio, repositorio ni escritor.

La frontera requiere dependencias explícitas para detector, consentimiento, interruptor de análisis y resolución de exclusión. La resolución de exclusión debe provenir de la composición confiable del runtime y falla cerrada si responde `true`, lanza o no devuelve `false`. No hay un detector, store o callback predeterminado que pueda activar solicitudes.

## Procedencia A–F

| Clase | Tratamiento C.5a |
| --- | --- |
| A. Mensaje directo original del usuario | Única entrada posible, y solo tras consumir la capability opaca para el texto exacto. Ser directo prueba el origen de entrada local, no que cada afirmación sea independiente o cierta. |
| B. Respuesta del asistente | Nunca se envía como entrada. Si se expuso en la conversación, el host puede marcar la sesión como no elegible para turnos posteriores. |
| C. Resultado de herramienta | Nunca se envía. El host confiable debe marcar la exposición antes de una posible evaluación. |
| D. Memoria recuperada | No se lee ni se envía. Una exposición debe marcarse como contexto no confiable. |
| E. Dato derivado/parafraseado de una herramienta | No es posible identificar todas las paráfrasis semánticas. Para eludirlas de forma conservadora, la sesión queda bloqueada después de marcar una exposición externa; no se intenta cotejar o almacenar el contenido fuente. |
| F. Dato que el usuario aporta independientemente | No puede certificarse por una etiqueta, claim del modelo o frase del usuario. C.5a solo acepta una entrada directa exacta sin exposición conocida y que supere el filtro; no demuestra de forma perfecta que un texto pegado o una afirmación no etiquetada sea independiente. |

No existe una operación para limpiar una marca de exposición durante la sesión. `recordUntrustedContextExposure()` acepta únicamente una capability real vigente y uno de cuatro motivos cerrados (`assistant_output`, `tool_result`, `retrieved_memory`, `derived_external_data`); todos producen el mismo efecto: bloquear. El nombre de clase no concede confianza. Si el runtime no llama a esta operación cuando presenta esos datos, ningún componente aislado puede inferirlo con certeza. Esa instrumentación completa es requisito de C.5b.

Además, una evaluación que alcanza el detector marca la sesión completa como expuesta, ya que el texto puede haber salido del proceso. Por tanto C.5a permite como máximo una evaluación externa por sesión local y no reabre la sesión ante error, timeout o cancelación. Una sesión nueva tiene otro identificador. Es una política deliberadamente restrictiva, no un límite de la cuenta OpenAI.

## Flujo aislado

```text
stdin original
  → capability opaca real, ligada a destinatario/turno/hash
  → consumo único en assessment-boundary
  → sesión sin exposición externa conocida
  → interruptor + consentimiento persistente + exclusión de conversación
  → filtro previo fail-closed (incluida exclusión por mensaje)
  → detector inyectado explícitamente, solo {text, AbortSignal}
  → validación de schema/evidencia y policy determinista
  → candidatos efímeros no confiables; authorizationGranted=false, writeReady=false
```

No se pasa historial, respuesta del asistente, argumentos/resultados de tools, contexto recuperado, IDs canónicos ni credenciales. La propuesta del modelo no puede asignar provenance, permisos, autorizaciones, grants, IDs de assertion, ni destino de reemplazo; los campos adicionales hacen que la salida sea rechazada. La policy es una clasificación, no autorización. Incluso `auto_save` queda como sugerencia y esta frontera no tiene API para encolar o persistir candidatos.

El consentimiento y el interruptor de análisis se vuelven a comprobar antes de extraer y después de la respuesta. La exclusión de conversación también se vuelve a comprobar. Una revocación, desactivación del análisis o exclusión durante una solicitud descarta la salida; el host debe llamar `cancelActive()` al revocar, desactivar o cerrar para abortar pronto la petición. El timeout por defecto es 5 segundos (la configuración no admite más); se envía el `AbortSignal` al SDK. Se ignora cualquier resultado tardío incluso si un detector simulado no coopera. AbortSignal cancela la espera/transporte compatible, pero no puede probar que un proveedor ya no haya recibido o procesado una petición.

## Privacidad, categorías y retención

La frontera conserva los filtros existentes: secretos/credenciales, datos financieros de autenticación, documentos de identidad, ubicación o movimiento preciso, datos de pacientes y secretos profesionales, citas/importaciones, contenido temporal y entradas ambiguas detectables se bloquean antes del detector. Salud, finanzas personales, relaciones delicadas, asuntos legales/migratorios e información íntima/profesional pueden alcanzar policy únicamente según los filtros existentes y quedan en `ask` si se clasifican como sensibles. Preferencias, proyectos y herramientas de bajo riesgo pueden recibir una disposición de policy, pero no se escriben. Los datos operativos de terceros y cualquier sesión con exposición externa conocida quedan excluidos.

El request de Responses fija `store: false`, no usa herramientas y no emplea estado de conversación o background mode. Esto no equivale a retención cero: la documentación pública de OpenAI describe por separado el estado de Responses y los registros de supervisión de abuso; por defecto dichos registros pueden incluir contenido y conservarse hasta 30 días, sujeto a excepciones. Los controles ZDR/MAM requieren aprobación y pueden configurarse por organización/proyecto; la configuración del proyecto puede prevalecer sobre el valor de organización. [Data controls oficiales](https://developers.openai.com/api/docs/guides/your-data) · [requisitos de ZDR/MAM](https://help.openai.com/en/articles/9047878-how-can-i-contact-sales).

No se leyó `.env`, variable de API, panel de cuenta, configuración de proyecto ni credenciales; no se hizo ninguna solicitud real. Por eso el estado efectivo para la cuenta/proyecto de Nexa permanece desconocido y la activación real queda bloqueada. La ficha previa a C.5b debe registrar, sin copiar claves:

| Verificación de cuenta/proyecto (pendiente del usuario) | Resultado |
| --- | --- |
| Organización y proyecto API que corresponden a la clave local (identificadores no secretos) | Pendiente |
| Retención seleccionada para el proyecto y si hereda o anula la organización | Pendiente |
| ZDR, MAM, controles de abuso y elegibilidad del modelo/endpoint | Pendiente |
| Confirmación de que `store: false` y los demás parámetros de la solicitud son compatibles con la configuración elegida | Pendiente |
| Aceptación del usuario de la retención y tratamiento aplicables, incluidos límites/excepciones | Pendiente |

🔴 **DECISIÓN TUYA NECESARIA — No avanzar a C.5b con llamadas reales hasta revisar la configuración efectiva del proyecto en el panel y aceptar expresamente el nivel de retención y tratamiento que corresponda.** `store: false` no resuelve esta decisión.

## Pruebas y evidencia

`test/memory-automatic-c5a.test.js` usa capabilities emitidas por lectura sintética real de `stdin` en procesos hijos, detector/consentimiento simulados y un cliente Responses falso. Incluye:

- texto directo válido; string `direct_user`, objeto estructural, texto alterado, claims de modelo/tool/import y capability inválida;
- consentimiento ausente/obsoleto, switch de análisis apagado, exclusión conversacional, opt-out por mensaje;
- credenciales, localización, datos de pacientes, citas, inyección y contenido mixto;
- paráfrasis sintéticas de CRM, correo, banco, memoria y salida del asistente después de registrar exposición;
- salida ambigua/condicional, salida de salud/finanzas que debe pedir confirmación y campos falsos de autorización;
- revocación/exclusión durante el request, timeout, AbortSignal, cancelación, resultado tardío;
- Responses API simulada con `store:false`, `tools:[]`, schema estricto y señal de cancelación;
- ausencia de imports/rutas de escritura desde la frontera.

Estas pruebas verifican el contrato local y salidas simuladas, no la calidad del modelo real, la eficacia perfecta de la detección semántica, la retención efectiva de la cuenta ni la cancelación en el servidor. Ninguna prueba hace llamadas de red, usa claves, crea cola/store de propuestas o escribe Memory1/Memory2.

## Estado de controles

- Extractor real en el CLI: **desconectado**. No hacer `--live`.
- Análisis automático en el CLI: **desactivado** por defecto; la implementación C.5a no se conecta al hook de agente.
- Guardado automático: **desactivado**. No hay ruta de escritura en esta frontera.
- Memory2 personal/retrieval: **apagados**; Memory1 sigue siendo backend efectivo.
- Migraciones y recuerdos personales: **ninguno**.
- Dependencias: **sin cambios**.

## Requisitos para C.5b

1. Resolver 🔴 la retención del proyecto y aceptar el tratamiento de datos antes de cualquier solicitud real.
2. Reemplazar el hook C.2 de texto plano. El `runtimeContextCapability` actual se invalida al liberar el turno dentro de `readAndRun()`, antes de `completePresentedTurn()`; por eso C.5a no se puede conectar post-respuesta sin cambiar y volver a auditar ese ciclo de vida.
3. Instrumentar desde el runtime confiable, no desde el modelo/tools, todas las exposiciones de resultados de herramientas, memoria y contexto externo; marcar cualquier turno posterior como bloqueado. Cualquier caso de procedencia no verificable debe fallar cerrado.
4. Conectar exclusivamente el detector aprobado detrás de esta frontera, con consentimiento leído del store real, exclusión de conversación del store real, interruptor independiente vigente, timeout/cancelación al revocar/cerrar y salida estructurada efímera.
5. Verificar con pruebas adversariales que el modelo, tools, comandos `agent.run(text)`, memoria recuperada y datos importados no puedan emitir ni sustituir la capability.
6. Mantener sin cambios Memory1, escrituras y activación personal hasta una etapa de aprobación separada. El usuario debe decidir aparte las categorías que pueden analizarse y qué hacer con propuestas sensibles.

🔴 **DECISIÓN TUYA NECESARIA — También debe aprobarse expresamente la política conservadora de marcar como no elegible el resto de la sesión después de una exposición externa o de una evaluación enviada al proveedor.** Cualquier alternativa menos restrictiva necesita un método revisable para atribuir procedencia sin usar paráfrasis del modelo como prueba.
