# Automatic Memory C.5b — Procedencia, fuentes de verdad y límites de aislamiento

## Estado

C.5b conserva el trabajo no consolidado de C.5a y lo compone con el runtime de CLI detrás del interruptor explícito de evaluación. El CLI normal todavía crea `createAgent()` sin detector y `enableAutomaticMemoryAssessment` sigue en `false` por defecto. No se habilitó el extractor real, no se hizo ninguna solicitud a OpenAI, no se añadió un conector de Lifeguard y no se escribió ninguna propuesta ni recuerdo.

La frontera C.5a se ejecuta después de que el host presenta la respuesta y antes de que el runtime permita leer otro turno. El agente entrega exclusivamente el texto original de `stdin`, la capacidad opaca vigente y una señal de cancelación; no entrega el historial, resultados de tools, memoria recuperada, IDs canónicos ni valores de provenance propuestos por el modelo. La salida validada sigue siendo efímera y no concede autorización ni queda lista para persistencia.

## Registro de fuentes

`src/memory/automatic/source-registry.js` contiene políticas inmutables asignadas por código. No lee metadata de resultados externos ni permite que un campo como `memory_policy` enviado por una tool cambie la clasificación.

| Fuente canónica | Tipo | Política de memoria | Frescura |
| --- | --- | --- | --- |
| `user:direct` | `user_assertion` | `candidate_only` | `turn_scoped` |
| `api:lifeguard` | `financial_live` | `never_store` | `always_fetch` |
| `email` | `communication_content` | `never_store` | `always_fetch` |
| `calendar` | `schedule_live` | `never_store` | `always_fetch` |
| `memory` | `retrieved_memory` | `never_store` | `repository_state` |
| `web` | `external_web_content` | `never_store` | `always_fetch` |
| origen desconocido | `unknown_external` | `never_store` | `unknown` |

El runtime asigna la política a partir del nombre de tool que ejecutó, no de argumentos o resultados de la tool. Las lecturas actuales de correo y calendario se reconocen por nombre; `web_search` se clasifica como `web`. Toda respuesta de tool bloquea la evaluación automática, incluso cuando el origen no se reconoce. La respuesta externa no recibe campos de metadata serializados hacia el modelo: el evento de procedencia conserva únicamente la clase canónica, los identificadores efímeros del turno y el resultado de bloqueo, nunca el payload.

No se encontró un conector actual de CRM Lifeguard en las tools de `src/tools`; por eso `api:lifeguard` existe como política de fuente para un futuro adaptador, pero C.5b no crea ni finge una integración. Los resultados operativos/financieros deberán volver a consultarse en su sistema de origen.

## Ciclo de vida confiable

```text
stdin original
  ├─ capacidad opaca de evaluación: destinatario + sesión + turno + hash del texto
  └─ capacidad opaca de exposición: mismo vínculo, uso independiente y único
          ↓
  readAndRun conserva ambas durante el turno
          ↓
  el runtime marca un resultado de tool o memoria antes de añadirlo al contexto del modelo
          ↓
  respuesta presentada por el host
          ↓
  completePresentedTurn serializa la evaluación C.5a
          ↓
  consumo de prueba, consentimiento/filtro/policy, descarte de candidatos efímeros
          ↓
  finalización explícita; siguiente stdin, EOF, cierre o reinicio también invalida
```

`releaseDirectUserTurn()` solo consume la capacidad del comando de memoria; ya no invalida antes de tiempo las pruebas de procedencia. La prueba de evaluación y la prueba de exposición son objetos opacos emitidos al leer `stdin` real, ligados al mismo texto, destinatario, sesión y turno. Separarlas permite al runtime registrar una exposición y aún así consumir la prueba de evaluación para recibir un rechazo explícito. No se aceptan strings, objetos estructurados, nombres de fuente ni metadata de origen como prueba.

`completePresentedTurn()` permanece serializado en la cola del agente. Si el host no lo llama, el siguiente `readAndRun()` finaliza la prueba anterior antes de aceptar otra línea; EOF y cierre limpian las capacidades. Una confirmación, una llamada directa a `agent.run(text)` o una respuesta de modelo no reciben autoridad de `stdin` para evaluar texto.

El agente marca una exposición antes de volver a incluir el resultado de una tool en el historial del modelo. Las tools no registradas se clasifican como `tool:unclassified` y también bloquean. Si la recuperación de Memory2 aporta contexto, ese contenido se marca como `memory` y bloquea la evaluación del turno. La marca no elimina ni cambia el resultado que necesita la conversación; únicamente impide que el flujo automático lo use como candidato.

## Bloqueo y separación entre turnos

C.5b mantiene el bloqueo conservador heredado de C.5a: una exposición verificada de tool/memoria o una evaluación que llega al extractor marca la sesión completa del runtime como no elegible. Esto impide que el mismo usuario reescriba una respuesta financiera o de correo como si fuera una afirmación directa. El bloqueo no se limpia por un flag `never_store`, por una paráfrasis, por un nombre de fuente distinto ni por un nuevo mensaje `stdin` dentro de esa sesión.

Se evaluó reducir la marca a un único turno, pero el análisis automático de seguridad rechazó ese cambio porque una paráfrasis posterior podría alcanzar al extractor. El usuario autorizó diseñar y validar una política más estrecha antes de implementarla; esa revisión está pendiente. C.5b no debilita la protección existente.

Una separación demostrable requeriría que el runtime pueda identificar una unidad nueva cuyo contexto conversacional no contenga resultados externos o memoria recuperada, y conservar esa lineage hasta la evaluación. La CLI actual conserva el historial de conversación y no proporciona un certificado de independencia semántica entre una frase posterior y el resultado externo previo. Un detector puede ayudar a encontrar similitudes, pero no puede certificar por sí solo que no existe derivación. Los datos pegados sin identificar y las paráfrasis semánticas tampoco se pueden detectar perfectamente. Mientras eso no se resuelva, el bloqueo de sesión continúa siendo el comportamiento correcto. No se anuncia una reanudación segura de análisis dentro de la misma sesión después de usar tools.

### Política más estrecha propuesta y validación

La unidad mínima segura que el diseño actual permite recuperar es una **nueva sesión de runtime con contexto conversacional vacío**, no el turno siguiente de la sesión contaminada. La política propuesta conserva la marca de contaminación para toda la instancia actual del agente y solo permite evaluar un nuevo turno cuando una instancia nueva emite una capacidad nueva de `stdin`, no ha recibido resultados de tools/memoria y el extractor recibe exclusivamente ese texto original. No se limpia la marca por tiempo, por nombre de fuente, por `never_store`, por una afirmación del modelo ni por un comando conversacional. Hoy crear esa frontera requiere iniciar una instancia nueva; no existe un comando de reset de contexto que la finja.

Esta política se validó con una prueba sintética sobre las fronteras reales: el resultado `api:lifeguard` bloquea tanto el turno expuesto como turnos posteriores de la misma frontera; otra frontera nueva, con consentimiento de alcance entre sesiones y un turno directo independiente, puede evaluar su texto una sola vez. La prueba demuestra aislamiento de capacidades y estado del runtime, no independencia semántica de lo que la persona escriba después. La instancia nueva no hereda historial del modelo, pero el software no puede demostrar que una persona no recuerde, copie o reformule un dato externo de una sesión anterior. El filtro de secretos y las reglas sensibles siguen aplicando; no se atribuye al registro de fuentes una capacidad de detectar paráfrasis.

Por eso, esta alternativa es una reducción acotada del bloqueo operativo, no una garantía de que ningún dato externo vuelva a ser mencionado. Si el requisito es impedir también que una persona reintroduzca en una sesión nueva una paráfrasis de datos confidenciales, el bloqueo debe extenderse a través de sesiones o se necesita una decisión explícita de privacidad sobre qué categorías nunca se analizan. No se debe implementar una limpieza automática de contaminación en la sesión actual hasta revisar y aprobar esta política y sus límites.

## Controles y alcance

- El agente usa `assessment-boundary.js`; no llama al detector directamente desde el hook antiguo de texto plano.
- La fábrica de detector real sigue marcada por el módulo OpenAI y `createAgent()` rechaza su inyección directa en este camino. El CLI no inyecta un detector.
- El cliente Responses permanece configurado con `store: false`, `tools: []`, schema estricto y `AbortSignal`; los tests usan un cliente falso, sin red.
- Revocación, exclusión, cierre y timeout cancelan el trabajo y descartan respuestas tardías.
- La evaluación no almacena propuestas, no invoca `MemoryService`, repositorios ni tools, y no concede permisos.
- Consentimiento de análisis no equivale a autorización de persistencia. ASK, IGNORE, DUPLICATE y `auto_save` no se convierten aquí en escritura.
- El dato de sesión local no autentica a una persona.

## Pruebas

Las pruebas sintéticas de C.5b y C.5a cubren capacidades independientes de evaluación/exposición, vínculo exacto de texto, reutilización y expiración; políticas de fuente fijas y fuente desconocida; resultado Lifeguard `financial_live` marcado `never_store`; tool y memoria recuperada; bloqueo conservador de exposición; evaluación solo después de presentar respuesta; herramientas/modelo fuera de la entrada del extractor; timeout, cierre, revocación y salida tardía; ausencia de escritura y ausencia de llamadas reales.

Las pruebas no demuestran que las paráfrasis futuras se puedan identificar, que un usuario no copie datos vistos previamente, ni que un proveedor no haya recibido una petición antes de cancelarla. No prueban retención efectiva de cuenta/proyecto ni calidad del extractor real. No se realizaron pruebas con CRM real ni con datos personales.

## Decisiones pendientes antes de una llamada real

1. Revisar en el panel de OpenAI la organización/proyecto de la clave local, los controles de datos y la retención efectiva; no se consultaron credenciales ni configuración privada desde esta etapa. `store: false` por sí solo no significa retención cero.
2. Aceptar expresamente el tratamiento/retención correspondiente antes de cualquier llamada real.
3. Revisar la propuesta de frontera nueva con contexto vacío. Para permitir una sesión nueva hay que aceptar expresamente el límite de que el sistema no puede inferir si la persona recuerda o reescribe información externa de una sesión anterior; si ese límite no es aceptable, mantener el bloqueo persistente o excluir esas categorías antes del extractor.

Memory1 continúa como backend efectivo; Memory2 no se activa ni se migra. C.5b no inicia C.5c ni autoriza uso personal.
