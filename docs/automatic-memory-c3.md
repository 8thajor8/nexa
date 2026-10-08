# Automatic Memory C.3 — Consentimiento y controles de privacidad

> Nota de evolución: C.3 documenta el consentimiento volátil original. Automatic Memory C.4 agrega el consentimiento local persistente y la cola experimental; el estado actual y sus límites están en `automatic-memory-c4.md`.

## Estado

C.3 implementa controles de sesión, consentimiento explícito, filtro previo y límite de ejecución para el hook experimental. El extractor real no está conectado a la CLI, no se hacen llamadas adicionales a OpenAI y el detector simulado solo se usa en pruebas. No hay aprendizaje ni escritura de recuerdos.

El consentimiento se conserva solo en memoria dentro de la instancia de agente. No hay persistencia de consentimiento ni de propuestas. Esta opción evita guardar preferencias de privacidad sin una decisión del usuario; si se desea persistencia entre reinicios, se requiere resolverlo expresamente más adelante.

## Implementado

- `/automatic-memory consent` muestra finalidad, posible envío futuro del turno a OpenAI, exclusiones, alcance futuro y política vigente; el siguiente input debe repetir un challenge aleatorio exacto. Solicitud y confirmación son comandos directos de stdin, se consumen fuera del modelo y no pueden ser aprobadas por tool calls.
- `/automatic-memory revoke-consent` invalida el consentimiento de esta sesión, elimina trabajo aún pendiente e invalida/aborta el detector en vuelo. Un challenge de consentimiento vale solo para el siguiente turno; cualquier otra entrada lo consume.
- El recibo de consentimiento interno contiene versión `automatic-memory-c3-v1`, propósito, alcance de turnos futuros, fecha, sesión y exclusiones. No autentica a una persona ni concede permiso de escritura. Al reiniciar o cerrar se pierde.
- `automaticAnalysisEnabled` solo resulta verdadero cuando coinciden configuración explícita de código, detector inyectado y consentimiento válido. En la CLI real falta configuración e inyección, por lo que el consentimiento informado no activa ningún análisis ni envío.
- `automaticSavingEnabled` permanece fijado en `false`; no tiene setter, escritor ni ruta automática. ASK no se guarda, y no existe cola persistente de propuestas.
- `memoryRetrievalEnabled` solo gobierna Memory2. Al usar Memory2, conserva su comportamiento actual por defecto y puede desactivarse explícitamente. Para Memory1 el control es `null`: su prompt y recuperación tradicional no se alteran.
- El filtro `screenAutomaticMemoryTurn()` opera antes de retener texto para evaluación y falla cerrado ante entrada inválida, exceso de tamaño o errores. Reutiliza el screening de secretos y bloquea, por patrones, credenciales, credenciales financieras, documentos de identidad, ubicación/movimiento, señales explícitas de temporalidad, citas/importaciones y frases de inyección reconocidas. Devuelve solo un código fijo, nunca texto coincidente. El turno completo se omite; no se redacta parcialmente.
- Algunos temas sensibles permitidos, como salud o finanzas personales no credenciales, pueden pasar el pre-filtro tras consentimiento; la policy de Automatic Memory debe tratarlos como ASK y nunca como permiso de persistencia. Los datos identificables/confidenciales de terceros, pacientes y secretos profesionales no deben convertirse en auto-save.
- El detector recibe `{text, signal}` y el límite por defecto es 5 segundos (la configuración de código solo admite valores entre 1 y 5000 ms). Al vencer, se aborta y se ignora el resultado tardío. Solo se permite una evaluación en vuelo: si un detector no cooperativo persiste tras timeout o revocación, se omiten evaluaciones posteriores hasta que termine o cierre el proceso, para no acumular tareas. La cola conversacional se libera al timeout.

La aprobación actual de categorías para diseño no activa llamadas externas. El challenge de sesión tampoco cambia Memory1, selecciona Memory2 ni migra datos.

## Separar las etapas

El sistema debe tratar estas acciones como etapas distintas:

1. **Consentir el análisis:** autorizar que un mensaje elegible se envíe al extractor.
2. **Analizar:** recibir una clasificación/candidato; esto no crea una propuesta visible ni autoriza guardado.
3. **Proponer:** presentar al usuario, de forma independiente al texto del modelo, el recuerdo exacto y la acción ADD o REPLACE sugerida.
4. **Confirmar:** obtener una acción confiable ligada al plan exacto. REPLACE debe mostrar y confirmar el target anterior y el valor nuevo.
5. **Persistir:** ejecutar únicamente tras confirmación válida, con snapshot vigente, capability de un solo uso y recibo transaccional.

`auto_save` solo puede significar “candidato de bajo riesgo según policy”; nunca es permiso de escritura. ASK requiere una pregunta explícita. IGNORE y DUPLICATE no generan propuesta persistible.

## Alternativas y decisiones futuras

La implementación adopta opt-in de sesión con challenge de confirmación y revocación directa. No guarda consentimiento entre reinicios. Esto limita retención y evita decidir por el usuario dónde guardar una preferencia permanente. Consentir análisis no implica consentir persistencia; revocar impide nuevos análisis y descarta o invalida trabajo pendiente, pero no revierte recuerdos confirmados por otros medios.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. Si en el futuro quieres recordar consentimiento entre reinicios, ¿prefieres persistencia local o pedir consentimiento en cada sesión? C.3 no lo persiste.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. Antes de activar análisis real, ¿quieres una acción visible para omitir cada mensaje aunque el consentimiento de sesión esté activo?

## Exclusiones y clases de datos

El filtro omite el turno entero si detecta credenciales o secretos, credenciales financieras, documentos de identidad, ubicación/movimientos, temporalidad explícita, citas/importaciones, frases de inyección o secretos profesionales/datos de pacientes. No redacta partes del turno. Las reglas son heurísticas y solo reducen el riesgo: no cubren todas las formulaciones ni detectan cualquier dato personal. `eligible` no significa “sin datos sensibles”.

La política de producto suministrada permite evaluar salud, finanzas personales, relaciones, información legal/migratoria, trabajo/proyectos, temas emocionales y contexto general de terceros bajo consentimiento. Estos datos sensibles no son elegibles para guardado automático y requieren confirmación independiente antes de cualquier persistencia. Datos identificables/confidenciales de terceros, pacientes y secretos profesionales no deben transformarse en recuerdos personales. En C.3 no hay ruta de persistencia.

El pre-filtro se ejecuta sobre el texto original del turno de stdin antes de guardarlo como candidato de evaluación. Ante entrada inválida, demasiado larga o error interno, se omite. Solo se registra un reason code fijo; no se registra texto ni fragmentos.

## Qué se envía y cuándo

Solo un turno directo de stdin que pasó el pre-filtro y una respuesta conversacional textual completada puede quedar pendiente. La evaluación sucede después de presentar la respuesta y recibe solo `{text, signal}`. No se envían historial, herramientas, salida del assistant, Memory1/Memory2, documentos ni capacidades. No hay extractor real configurado, por lo que el envío adicional actual es cero. El aviso de consentimiento dice que podría enviarse a OpenAI si un extractor se compone explícitamente en una fase posterior.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. La autorización de C.3 no cubre envíos reales. Antes de conectar el extractor OpenAI se necesita una aprobación específica de una prueba limitada, con corpus, coste, retención y categorías cubiertas descritas.

## Propuestas y confirmación de guardado

- El extractor devuelve solo datos no confiables. La policy valida elegibilidad, sensibilidad, polaridad, durabilidad y forma.
- El planner decide ADD, REPLACE, ASK, IGNORE o DUPLICATE; no decide autorización.
- Los nombres de proyectos/personas sin identidad canónica continúan como datos textuales o ASK.
- ADD agrega sin borrar hechos compatibles.
- REPLACE exige target activo, valor anterior/nuevo mostrados y confirmación específica. Cambio de snapshot o target obliga a presentar otro plan y obtener otra autorización.
- La confirmación se recoge en una interfaz de runtime separada de `askOpenAI`; texto del asistente, argumentos/results de tools y texto citado nunca cuentan como aceptación.
- Cada operación tiene una capability de un solo uso y se confirma con assertion/evidence/provenance/receipt en una misma revisión. Reintentos de operaciones aplicadas se resuelven por recibo; autorización consumida sin recibo no se reutiliza.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. ¿Deseas confirmación por cada ADD, o autorizar una categoría pequeña y explícita de ADD de bajo riesgo por sesión? REPLACE siempre requiere confirmación específica en esta propuesta.

## Retención, proveedor y sensibilidad

Antes de activar un extractor real hay que decidir:

- retención local de candidatos: ninguna, temporal hasta cierre de sesión o conservación hasta decisión del usuario;
- persistencia de propuestas rechazadas: recomendación, ninguna;
- logging: solo códigos, recuentos, latencia y uso no identificativo; nunca texto, candidatos sensibles, prompts completos o capability;
- configuración de almacenamiento/retención del proveedor y tratamiento contractual aplicable; un parámetro técnico de no almacenamiento no debe prometer por sí solo ausencia total de retención;
- uso de métricas de tokens/coste y umbral de detención.

Recomendación: no persistir candidatos ni propuestas rechazadas; mantenerlos solo en memoria durante la interacción, borrarlos al confirmar/rechazar/cerrar y registrar diagnósticos sin contenido. Si una categoría sensible pasa el screening local, detenerse antes de la API; si se detecta después, no ofrecer guardado automático y pedir confirmación solo si la política elegida lo permite.

En C.3 no se crean candidatos persistentes ni propuestas pendientes. Los resultados del detector de pruebas se descartan. Una fase de propuestas agrupadas requiere definir duración y ubicación antes de implementarse.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. Antes de enviar mensajes reales, decide qué nivel de retención del proveedor aceptarías y qué configuración contractual/técnica debe verificarse.

## Timeout, cancelación y cierre

El hook pasa `AbortSignal` y admite un presupuesto de 1 a 5000 ms; el valor por defecto y máximo es 5 segundos. Al expirar, cierra la espera conversacional, emite solo un código y aborta la señal. Revocación/cierre también invalidan el job y abortan detectores cooperativos. Resultados posteriores al timeout, revocación o cierre se ignoran. No se reintenta automáticamente.

Si el detector ignora `AbortSignal`, su promesa y recursos pueden seguir vivos después del timeout. Solo se permite una evaluación en vuelo; se omiten evaluaciones posteriores hasta que la tarea termine o el proceso cierre. La cola conversacional progresa tras el timeout, pero esto no equivale a cancelación efectiva del transporte. Una futura integración debe verificar la cooperación del cliente/SDK; `Promise.race` no basta para liberar recursos externos.

## Desactivación y Memory1

El interruptor debe aislar el aprendizaje de la conversación ordinaria. Apagarlo debe detener nuevas extracciones, descartar pendientes y dejar intactos Memory1, su lectura, sus comandos explícitos y el agente. No borrar ni migrar recuerdos existentes como efecto secundario del interruptor. Memory2 seguirá desactivada hasta una aprobación y fase separadas.

La implementación mantiene análisis sujeto a configuración más consentimiento, guardado siempre apagado y recuperación Memory2 controlada aparte. Memory1 no consulta ese control y conserva su comportamiento.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. Memory2 conserva su recuperación actual si se selecciona como backend, aunque puede desactivarse con `memoryRetrievalEnabled: false`. ¿Debe la recuperación de Memory2 empezar apagada en toda futura activación? Memory1 está excluida de ese cambio.

## Decisiones pendientes y fases futuras

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. ¿Quieres conservar el consentimiento entre sesiones? Si sí, hay que elegir almacenamiento local, protección, revocación y migración de versión. Actualmente es volátil.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. ¿Quieres una acción por mensaje para omitir el análisis aunque exista consentimiento de sesión?

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. ¿Qué retención y configuración del proveedor aceptarías para un envío real? C.3 no usa OpenAI.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. ¿El guardado futuro de ADD de bajo riesgo requiere confirmación por propuesta, o autorizas diseñar una categoría reducida de guardado autónomo? Ningún flag actual concede autorización y REPLACE debe exigir aprobación específica.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. Memory2 mantiene por defecto la recuperación existente cuando se selecciona explícitamente; ¿debe una futura activación iniciar con recuperación apagada? Memory1 queda fuera de ese control.

🔴 DECISIÓN TUYA NECESARIA — No avanzar sin resolver esto. Si se crea una cola de propuestas agrupadas, ¿cuánto tiempo deben durar y dónde se conservarían? Actualmente no hay cola ni persistencia de propuestas.

Pendiente técnico: corpus adversarial más amplio para el pre-filtro, integración cancelable comprobada contra transporte real, diseño de propuestas agrupadas con expiración/eliminación y revisión separada de cualquier persistencia.

## Validación

Pruebas sintéticas: C.2/C.3 y ensamblado de contexto, 30/30; Automatic Memory, 87/87; Memory, 309/309; suite completa, 502/502 en la ejecución que permitió iniciar Chromium. La ejecución restringida quedó 501/502 por `spawn EPERM` en la prueba de voz. No hay evaluación de calidad del modelo, extractor real, retención del proveedor ni escrituras. El filtro no es exhaustivo y no debe presentarse como garantía de que todo contenido identificable quedó bloqueado.
