# Automatic Memory C.1 — Diseño de integración conversacional

## Alcance

Este documento diseña una integración futura de Automatic Memory con el agente real. No cambia el comportamiento: Automatic Memory no está conectada al agente, Memory1 sigue siendo el backend efectivo por defecto y no se habilita ni migra Memory2 personal. La base inspeccionada es `1b96ddab6760507bc7095a5a0129b0563b8f4fd9`.

## Arquitectura actual verificada

| Área | Implementación actual | Implicación para C |
| --- | --- | --- |
| Inicio y ciclo CLI | `src/index.js` carga `dotenv/config`, crea `createAgent()`, informa el backend y ejecuta un loop que llama a `nexa.readAndRun()`. Imprime la respuesta devuelta y luego vuelve a leer stdin. | Es la composición local y el único lugar apropiado para ordenar salida, revisión posterior y la siguiente lectura de stdin. No hay una UI conversacional aparte en este flujo. |
| Entrada confiable | `src/core/direct-user-input.js` implementa `readDirectUserTurn(recipient)`: lee stdin, genera sesión/turno y capability opaca ligada al destinatario y hash del texto. Detecta comandos explícitos de memoria. `readDirectUserConfirmation()` lee otra línea de stdin, la consume como confirmación y no la devuelve como mensaje. | El turno directo es origen local observado, no identidad humana autenticada. La capability de Automatic Memory expira al consumirla, al leer otro turno o al cerrar la sesión. |
| API del agente | `src/core/agent.js` serializa operaciones con una cola. `readAndRun()` obtiene un turno de stdin; los comandos de memoria pasan por autorización manual explícita. Los demás mensajes van a `run(message, 'direct_user')`. El objeto público `agent.run(message)` invoca `run()` sin fuente confiable, por lo que su default es `untrusted`. | C solo debe observar turnos que provengan de `readAndRun()` y de la capability real. Una cadena `source`, `userMessageSource`, `sessionId`, texto de `agent.run()` o la existencia de una sesión no prueban origen confiable. |
| Llamadas al modelo | `getModelResponse()` en `src/core/agent.js` llama a `ask()`; `src/brain/openai.js::askOpenAI()` llama a Responses API con `config.model`, instrucciones, entrada e interfaces de tools. La respuesta se añade a `conversation`; los `function_call` se ejecutan mediante `executeTool()`, y sus outputs se añaden al historial. Hay límite de rondas y una respuesta final sin tools. | Las respuestas del assistant, argumentos de tools, outputs de tools e historial son datos no confiables para Automatic Memory. Candidato solo desde el texto original del turno directo. |
| Historial y contexto | `conversation` conserva mensajes del usuario, outputs del modelo y outputs de tools durante la instancia. Si Memory2 está seleccionada, `getModelResponse()` añade items acotados de `contextProvider.read()` antes del historial. Un cambio del digest invalida historial derivado. Memory1 se representa en instrucciones mediante `memoryToPrompt()`. | No pasar `conversation`, historial, contexto recuperado ni outputs de tools al detector. No inferir una nueva afirmación a partir de un eco del assistant o de una memoria previa. |
| Detección A | `src/memory/automatic/detector.js` recibe exclusivamente `{text}`; sin stub llama a `extractAutomaticMemoryProposal()` en `src/brain/openai.js`. Esa llamada usa el modelo configurado, Structured Outputs, `tools: []`, `store: false` y un máximo de 2400 tokens de salida. Hace screening heurístico de credenciales antes de enviar. | Es una llamada adicional a OpenAI con el texto original; no está conectada a `createAgent`. El filtrado no garantiza detección de toda información sensible. Los fallos del detector se convierten en errores seguros, pero el cliente actual no acepta una señal AbortSignal de C. |
| Tools | `getToolsForModel()` ofrece tools al modelo y `executeTool()` ejecuta registrations locales. Algunas tools existentes escriben Memory1 mediante `saveMemory`; el flujo Memory2 oculta las tools manuales de memoria al modelo y rechaza invocaciones de nombres de memoria. No hay import de Automatic Memory ni llamada a `commitAutomaticOperation()` desde `src/core/agent.js`, `src/tools/*` o `src/index.js`. | No exponer detector, planner, coordinator, repo, capability ni writer como tool. La afirmación de aislamiento se limita a la ruta Automatic Memory: las interfaces de tools existentes no son una garantía de que todo dato de una conversación permanezca fuera de herramientas externas. |
| Errores y cierre | Los errores de `run()` se propagan; `readAndRun()` libera la capability del turno en `finally`. `src/index.js` muestra el error y continúa el loop. En el cierre se cierra input, backend, WhatsApp y speech. No se observa una cancelación AbortSignal por turno en el flujo de `askOpenAI()`. | C debe definir la vida del turno pendiente, cancelación y limpieza sin retener proofs en errores, salida o reinicio. Un error de detección nunca debe cambiar la respuesta ya generada ni habilitar una escritura. |

### Distinciones de confianza

- El límite confiable disponible es la lectura original desde stdin, más sus capabilities opacas privadas. El `sessionId` del agente o principal local identifican contexto de proceso; no autentican al propietario ni prueban control humano exclusivo.
- `run(message, 'direct_user')` usa actualmente una etiqueta interna al preparar el contexto de tools. No debe reutilizarse como provenance o autorización de Automatic Memory. La API pública `agent.run(message)` es no confiable para este propósito.
- Una propuesta, sugerencia de disposición, quote, valor, identidad o target del extractor son datos no confiables hasta que código determinista los valide contra el texto exacto y el snapshot. El modelo nunca recibe la capability de input ni la de autorización.
- La confirmación de `readDirectUserConfirmation()` es otra entrada local, separada del ciclo de tools/modelo. El preview y challenge del coordinador deben mostrarse por CLI fuera del contenido enviado al modelo.
- Memory2 devuelve contexto de datos y puede enviarlo al modelo conversacional si Memory2 está habilitada. El contexto no autentica ni autoriza. C debe mantener los datos de Automatic Memory fuera de argumentos, resultados y descripciones de tools.

## Flujo propuesto

```mermaid
sequenceDiagram
    participant U as Usuario en stdin
    participant CLI as src/index.js / coordinador CLI
    participant A as Agent
    participant M as Modelo conversacional
    participant D as Detector A
    participant P as Policy + Planner + contrato
    participant C as Coordinador B.2b.7
    participant R as Writer/repositorio v5

    U->>CLI: mensaje directo
    CLI->>A: readAndRun() conserva internamente capability del turno
    A->>M: conversación normal + tools existentes
    M-->>A: respuesta y, si aplica, llamadas a tools
    A->>A: ejecuta tools; no invoca Automatic Memory
    A-->>CLI: respuesta final
    CLI-->>U: muestra la respuesta primero
    CLI->>D: solo texto original + capability privada del turno
    D-->>P: propuesta cerrada y evidencia candidata
    P->>P: policy determinista → ADD/REPLACE/ASK/IGNORE/DUPLICATE
    P-->>C: solo operación elegible + snapshot binding
    C-->>U: preview local exacto y challenge separado
    U->>CLI: confirmación nueva por stdin, fuera del turno conversacional
    CLI->>C: consume proof y emite capability opaca de operación
    C-->>R: capability + plan y snapshot exactos
    R->>R: revalida, consume una vez, verifica freshness/recibo y persiste una revisión
    R-->>CLI: applied / already_applied / rechazo / resultado incierto
    CLI-->>U: informa resultado sin reenviar capability al modelo
```

El diagrama representa el diseño objetivo, no el comportamiento actual. En particular, la ruta actual de `readAndRun()` libera el proof en `finally` antes de devolver el control al loop que imprime la respuesta. Para mostrar la respuesta antes de iniciar detección y conservar el proof el tiempo justo, C debe introducir una fase interna de finalización posterior a presentación; no debe ampliar el tiempo de vida de una capability global ni devolverla al modelo.

## Diseño recomendado

### Fases de un turno

1. **Captura:** el lector existente crea el turno directo. La composición confiable guarda de forma privada el texto original y el handle opaco; no inserta claims fabricados en `conversation`.
2. **Respuesta:** el agente ejecuta el ciclo actual de modelo/tools y entrega la respuesta final. Los errores de tools siguen siendo parte de la conversación existente, pero nunca son fuentes para detección.
3. **Presentación:** `src/index.js` imprime la respuesta al usuario antes de esperar la extracción o una revisión de memoria.
4. **Evaluación posterior:** una operación confiable sin argumentos invocables por el modelo consume el turno pendiente una sola vez. Solo entonces llama a A con el texto original, y corre normalización, secret screening, policy, planner y contrato. Mantiene solo estado efímero privado hasta terminar; no persiste candidatos ni conversación.
5. **Decisión:** IGNORE/DUPLICATE terminan sin prompt; ASK presenta una aclaración conservadora o se descarta según razón, sin escritura; ADD/REPLACE elegibles se presentan como propuesta. `auto_save` significa elegible para propuesta, nunca permiso.
6. **Confirmación:** para el primer C, tanto ADD como REPLACE requieren confirmación individual vía lector de stdin del coordinador. REPLACE muestra exactamente el target activo y los valores anterior/nuevo. La confirmación no entra en `conversation`; no se acepta “sí” del modelo, llamada de tool, output citado ni un `source` string.
7. **Persistencia:** el controlador interno pasa al repositorio la capability real, operación y snapshot exactos. El writer B.2b.8 recalcula la operación y valida el snapshot real bajo lock. No se vuelve a planificar silenciosamente. Ante conflicto se cancela la propuesta y se necesita nuevo plan, nueva presentación y nueva confirmación.
8. **Liberación:** ante resultado, excepción, cancelación o cierre se liberan texto/capabilities efímeros. Ante `already_applied` se informa sin consumir una nueva autorización ni duplicar el cambio. Ante `memory_commit_uncertain` se aplica el procedimiento B.2b.8c; no hay reintento ciego.

Para conservar el orden del stdin, la propuesta inicial es que `readAndRun()` retenga internamente un único turno pendiente y que `src/index.js`, después de imprimir la respuesta, invoque una fase tipo `completePresentedTurn()` sin pasar texto ni proof. La siguiente lectura normal de stdin no comienza hasta que esa fase termina o cancela el trabajo pendiente. La respuesta no espera la detección; sí puede demorarse el siguiente prompt mientras se hace extracción/revisión. Si eso resulta demasiado intrusivo, se requerirá un lector de stdin multiplexado explícito; no deben competir `readDirectUserTurn()` y `readDirectUserConfirmation()` por el mismo stream.

### Detección y carga

- Usar exclusivamente una vez el mensaje de usuario capturado por `readDirectUserTurn()`. Excluir cadenas enviadas mediante `agent.run()`, comandos explícitos Memory1/Memory2, mensajes vacíos, respuestas del assistant, historial, argumentos/resultados de tools, texto de memoria, contenido de documentos/importaciones y contenido cuya procedencia no sea ese turno directo.
- Usar `turnId` y hash exacto, privados, para deduplicar dentro del proceso. No usar `sessionId` como identidad o autorización; no escribir hashes/candidatos como recibos para simular un ledger de turnos. Si el worker se reintenta antes de persistir, la política de reintento debe ser explícita y el turno no debe evaluarse dos veces accidentalmente.
- No bloquear la respuesta conversacional. Priorizar que el detector arranque solo después de la respuesta final; así tampoco compite innecesariamente por CPU/red con el ciclo de tools. Para errores, timeout o cancelación, descartar el trabajo sin afectar la respuesta.
- A expone una llamada extra a OpenAI con el texto del turno, aunque la conversación ya se haya enviado al modelo principal. La pantalla local actual detecta algunos secretos, no toda información sensible. Por ello la detección conversacional debe permanecer opt-in y apagada por defecto hasta definir aviso/consentimiento de procesamiento, política de datos y una regla para no enviar categorías que no deban salir del equipo. No afirmar que el screening heurístico hace seguro transmitir cualquier texto.
- Una sola llamada de extracción por turno elegible; no re-ejecutarla por cada tool round ni por cada respuesta de assistant. Errores estructurados o de red se registran como reason code seguro, sin texto, candidato, secreto, capability ni prompt en logs. La API de extracción debería añadir un timeout/cancelación compatible antes de la integración real.
- Antes de invocar el coordinador, conservar el límite de datos: a tools públicas no se pasan candidatos, previews de autorización, proofs, snapshots completos ni funciones del writer. El preview va solo a stdout local. Los diagnósticos registran estado y duración, no contenido de usuario.

### Política de producto inicial

| Resultado de A | Experiencia propuesta para C inicial | Escritura permitida |
| --- | --- | --- |
| `auto_save` y planner ADD | Tras responder, Nexa muestra una propuesta breve y el efecto exacto. El usuario puede confirmarla o dejarla pendiente/descartarla. | Solo después de confirmación independiente y grant nuevo ligado a ese ADD/snapshot. Nunca silenciosa en el C inicial. |
| REPLACE | Mostrar afirmación anterior, nueva y target único; pedir challenge específico que identifica el target. | Solo con confirmación de ese REPLACE exacto. Una modificación del target/dato/snapshot invalida la propuesta. |
| ASK por sensibilidad, tercero, ambigüedad o corrección no resuelta | No guardar. Si la policy lo permite, hacer una pregunta breve de aclaración; una respuesta normal crea un turno nuevo y debe volver a detectarse, no se trata como grant. Para sensibilidad alta, preferir no volver a exponer el contenido sin necesidad. | Ninguna mientras siga en ASK. Nunca degradar ASK a ADD por conveniencia o porque el usuario respondió genéricamente. |
| IGNORE o DUPLICATE | Sin notificación intrusiva, salvo que producto requiera una respuesta explícita. | Ninguna. |
| Candidato temporal, citado, importado, hipotético, negado o no sustentado | Descartar o mantener ASK según policy; no inferir una afirmación afirmativa. | Ninguna sin una nueva afirmación directa válida y flujo nuevo. |

La palabra `auto_save` en A describe solo una decisión de elegibilidad semántica. En el C inicial no hay autorización amplia por conversación ni preferencia persistente que permita guardar sin confirmación por operación. Una futura opción de aprobación categórica requeriría un diseño de permisos distinto y consentimiento revocable; queda fuera de C.1.

## Alternativas consideradas

| Alternativa | Ventaja | Riesgo / decisión |
| --- | --- | --- |
| Detectar antes de producir respuesta | Mantiene el turno y su capability disponibles sin estado pendiente adicional. | Añade una llamada serial a la latencia visible, puede afectar la respuesta ante errores y empeora la experiencia. No recomendada. |
| Detectar en paralelo con la conversación | Reduce latencia adicional y puede terminar antes de la respuesta. | Compite por llamadas/coste, vuelve compleja la cancelación y retención de proof; exige sincronizar con tools, siguiente turno y mutaciones de contexto. Posible optimización posterior, no primer paso. |
| Detectar después de mostrar respuesta, antes de aceptar otro stdin | La respuesta sale primero; un único dueño del stdin ordena confirmación y turno siguiente; el extractor nunca ve la conversación completa. | Puede demorar el siguiente prompt. Recomendada para el CLI actual; medir y revisar UX antes de optimizar. |
| Usar salida del modelo o una tool `remember` como autorización | Reutiliza el ciclo existente. | Confunde proposal/claim con autoridad y permite self-approval. Descartada. |
| Hacer que `agent.run(text)` afirme `direct_user` | Simple de llamar desde cualquier host. | El llamador puede fabricar el texto o etiqueta. No sirve como origen confiable; descartada. |
| Exponer repositorio/writer como tool | Flexible para el modelo. | Permite elusión de policy/capability y filtración de autoridad. Descartada. |

## Roadmap propuesto

| Etapa | Objetivo y módulos probables | Dependencias | Pruebas / riesgos | Criterio de aceptación |
| --- | --- | --- | --- | --- |
| C.2 — Orquestación confiable de turno | `src/core/agent.js`, `src/index.js`, quizá wrapper privado en `src/core/direct-user-input.js`; modelo de turno pendiente y finalización post-presentación. Sin detector ni writer en primer commit. | Diseño C.1 aprobado. | Procesos con stdin: respuesta se imprime primero, un solo lector, `agent.run(text)` no crea turno elegible, cleanup por error/EOF/salida. Riesgo: retener proof demasiado tiempo. | Capability nunca sale del módulo/composición confiable; cada turno se libera una vez y no hay carrera de stdin. |
| C.3 — Evaluación conversacional read-only | Detector A conectado solo al texto original y una vez por turno; configuración opt-in apagada por defecto; timeout/cancelación; sin persistencia. | C.2; decisión de privacidad/consentimiento del llamado extra a OpenAI. | Extractor simulado; detector real solo en test manual autorizado; quoted/imported, secret, error, tool-origin, dedup, latency y cancellation. Riesgo: screening incompleto. | Ninguna escritura; error no afecta respuesta; candidato no aparece en conversación/tools/logs. |
| C.4 — Revisión y confirmación local | Coordinator B.2b.7 más UI CLI; preview post-respuesta; serialización de stdin. | C.3 y garantías de stdin. | Confirmación correcta/incorrecta, tool output “confirmado”, prompt injection, expiry, requests cruzadas, ADD/REPLACE exactos. Riesgo: UX y confusión de challenge. | Solo una confirmación de stdin independiente produce capability opaca para un plan exacto; ASK/IGNORE/DUPLICATE no tienen ruta. |
| C.5 — Escritura experimental aislada | Controlador interno llama al writer B.2b.8 con repositorio temporal v5; no activar el path personal ni entregar repo al agente/tools. | C.4; B.2b.8/8c revalidados. | ADD/REPLACE, replay, errores, snapshot obsoleto, proceso reabierto, fallo incierto, generic commit bypass. Riesgo: montaje de backend equivocado. | Todas las escrituras se quedan en directorio temporal y pasan revisión release; sin migración personal. |
| C.6 — Recuperación e idempotencia conversacional | Estado de resultados y reconciliación después de restart; mensajes para applied/already_applied/conflict/uncertain. | C.5. | Respuesta perdida, restart, retry, cancelación, conflicto; impedir doble prompt/grant. Riesgo: retry inadecuado ante incertidumbre. | Receipt aplicado evita duplicado; operación no aplicada requiere replan/confirmación/grant nuevos; uncertain bloquea reintento ciego. |
| C.7 — Recuperación de recuerdos/contexto | Integrar lectura limitada mediante `contextProvider` existente, invalidación tras escritura confirmada y aislamiento de conversación anterior. | C.5-C.6 y aprobación separada de UX de recall. | No leaking a tools, context limits, stale digest, forget/invalidation, injection en assertions, Memory1 sigue siendo fallback solo por selección explícita. | Contexto bounded, `data_only`, fuera de tool args y pruebas de invalidación; aún en repositorio de prueba. |
| C.8 — Readiness de activación | Runbook, opt-in, monitoreo seguro, backup/restore, recovery, privacidad y revisión de seguridad operacional. Sin migrar aún por defecto. | C.2-C.7 aprobadas y política de privacidad resuelta. | Pruebas sobre store sintético y rollback; verificación de env/backend y paths. Riesgo: activación accidental. | Readiness review independiente aprobada; backend sigue Memory1 hasta autorización explícita de activación. |
| C.9 — Activación personal/migración | Considerar activación o migración personal solo mediante decisión explícita futura. | C.8 y autorización separada. | No parte de C.1 ni se presume aprobada por otras etapas. | Aprobación específica para store/backend y cualquier migración; no ocurre automáticamente. |

## Riesgos y decisiones pendientes

1. **Privacidad del extractor (importante, bloqueo para detección real opt-in):** A hace un segundo envío del mensaje a OpenAI. `store:false` y límite de salida están implementados para esa llamada; el envío sigue ocurriendo y el screening de credenciales es heurístico. Se debe acordar aviso, consentimiento y categorías no transmitibles antes de habilitar detección sobre mensajes personales.
2. **Identidad (límite explícito):** stdin prueba origen local dentro del proceso, no una persona. Si C necesita distinguir cuentas, sesiones remotas o miembros del hogar, hace falta una capa Identity fuera de esta arquitectura.
3. **Vida de capability (importante):** `readAndRun()` libera el turno al retornar. C debe rediseñar el lifecycle privado post-presentación y probar cancelación/EOF/siguiente turno; no copiar capability a un objeto de respuesta para el modelo.
4. **Coste/latencia:** cada turno elegible añade una llamada Responses API. El diseño recomendado entrega primero respuesta y luego evalúa; el siguiente prompt puede esperar. Falta medir con consentimiento en una prueba controlada.
5. **Datos sensibles/secretos:** la clasificación sensible viene después de la extracción y no evita que el texto llegue al extractor. Si política de producto prohíbe ese envío, se necesita puerta local/opt-in antes de la llamada y debe documentarse que ningún clasificador heurístico garantiza cobertura semántica completa.
6. **Errores/cancelación:** extracción tiene errores sanitizados, pero no timeout/AbortSignal en la interfaz actual. La integración debe cancelar al cerrar y aislar el fallo del turno conversacional.
7. **Código interno confiable:** `repository.commit()` es una API de bajo nivel para servicios/migraciones legítimos. No entregar handle a módulos model-facing; verificar por tests y revisión de imports que solo el controlador confiable acceda a la ruta automática.
8. **Durabilidad:** persisten límites B.2b.8c: locks cooperativos, diferencias de filesystem, cortes de energía, crash durante rename y escritores externos que ignoren lock.
9. **Política de guardado:** decisión aprobada para el primer C: ninguna escritura silenciosa, aun cuando A recomiende `auto_save`. Confirmación operación por operación para ADD y REPLACE. Revisar de nuevo antes de considerar opt-in categórico.
10. **Estado de producción:** el runtime sigue en Memory1 por defecto. Las pruebas B.3 escribieron únicamente fixtures temporales; no hay base para activar o migrar memoria personal.

## Condiciones para iniciar implementación

- Aprobar este diseño y la experiencia post-respuesta, incluido el posible retraso antes del siguiente prompt.
- Resolver el permiso de privacidad para la llamada adicional de extracción; hasta entonces, integración apagada por defecto y pruebas con extractor simulado.
- Aprobar el cambio de lifecycle que conserva proof privado entre respuesta y finalización; mantener un único dueño del stdin.
- Mantener `agent.run(text)` y todas las entradas de tool/modelo como no confiables; solo la ruta desde `readDirectUserTurn()` puede habilitar evaluación.
- Confirmación independiente por operación, tanto ADD como REPLACE; no hay escritura basada solo en `auto_save`, pregunta conversacional ni salida de tool.
- Primeras pruebas de persistencia exclusivamente con repositorio temporal v5; Memory1 sigue efectiva y `data/memory-v2.json` personal no se crea.
- Cualquier activación personal, cambio de backend o migración se decide y autoriza en una fase separada.

## Recomendación

Proceder, tras revisión, a C.2: implementar solo el ciclo privado de turno pendiente y finalización post-presentación con pruebas de stdin, sin detector automático todavía. La propuesta conserva la respuesta conversacional como prioridad, evita carreras por el stdin y deja detection/auth/persistence como etapas separadas. La detección real sobre mensajes personales debe permanecer deshabilitada hasta resolver privacidad y consentimiento. No iniciar C.2 hasta que este diseño sea revisado y aprobado.
