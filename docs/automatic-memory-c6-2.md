# Automatic Memory C.6.2 — Compuerta hipotética de elegibilidad

## Alcance y estado

C.6.2 agrega una función pura para evaluar si un candidato sintético de tipo ADD reúne requisitos estructurales que, en una arquitectura futura, podrían permitir guardado autónomo. La decisión `ELIGIBLE_HYPOTHETICAL` no es consentimiento real, autenticación, permiso, autorización ni una capacidad. Todos los resultados contienen `executable: false`; el modo de ejecución y cualquier solicitud de ejecutar una escritura producen `DENY`.

La prueba positiva solo demuestra coherencia entre objetos de fixture construidos dentro de tests. Los campos `synthetic_verified`, `fixtureOnly`, un principal, un dispositivo, una sesión, un grant o un consentimiento estructurados no se pueden usar como prueba en producción: no existe emisor o almacén confiable conectado a esta compuerta.

C.6.1 pasa a la compuerta procedencia `untrusted_synthetic_input`, identidad ausente y consentimiento de guardado ausente. Por tanto, su integración devuelve `ASK` para candidatos que de otro modo podrían ser elegibles. La etiqueta de escenario `user:direct` de C.6.1 sigue sin ser prueba de origen. El flujo de simulación no llama al extractor, al agente, a MemoryService, al repositorio ni al coordinador de capacidades.

## Evaluación

`evaluateHypotheticalAutomaticMemoryGate(input)` devuelve una decisión estable con códigos de razón, sin incluir texto, secretos ni datos personales:

- `ELIGIBLE_HYPOTHETICAL`: candidato `auto_save_candidate` y ADD de categoría A admitida (preferencia, herramienta, compra, hobby, contexto profesional, idioma o situación), no sensible ni conflictivo, sin mención de terceros y con vínculos estructurales consistentes y fixtures hipotéticas válidas.
- `ASK`: falta información resoluble, la clasificación ya requiere revisión, hay conflicto, REPLACE/supersession, o se propone ámbito compartido.
- `DENY`: ejecución solicitada, opt-out, fuente externa, exclusión o revocación, dato sensible, estado inválido/obsoleto, identidad/sujeto/ámbito cruzado o permiso hipotético ausente.

Se da prioridad a la solicitud de ejecución, opt-out, fuente excluida y revocación/vencimiento de consentimiento antes de interpretar la clasificación del candidato. Fuentes `tool_output`, importadas, de modelo o desconocidas se rechazan. Un `direct_user` literal por sí solo no establece procedencia: las comprobaciones positivas requieren un conjunto de campos sintéticos mutuamente vinculados y siguen siendo solo fixtures.

La función reutiliza `evaluateAuthorizationPolicy` de C.5g.2 para evaluar un permiso hipotético exacto `memory.write` sobre `memory.automatic.add`, y `validateDeviceSessionSnapshot`/`evaluateHypotheticalSession` de C.5g.4 para comprobar consistencia de sesión, cuenta, instalación y dispositivo. Estas APIs devuelven evaluaciones hipotéticas no ejecutables. No se reinterpretan como autenticación real. Los tipos elegibles se limitan a las categorías A existentes de bajo riesgo; `decision` queda en ASK porque los proyectos todavía pueden ser solo texto, y `learning_activity`, `long_term_goal`, `relationship` y `other` no reciben elegibilidad autónoma. Una mención de tercero exige revisión aun si el sujeto estructural parece coincidir.

La compuerta exige sujeto canónico igual a la persona vinculada al principal de la fixture. Esto evita asignar un tercero a Self. El ámbito privado pertenece al principal de la fixture. Owner no recibe acceso implícito a recuerdos privados de otra persona. Un destino compartido requiere una fixture de permiso `shared`, consentimiento que declare ese ámbito y la lista exacta de destinatarios, y que cada destinatario esté activo en el directorio hipotético; incluso entonces la decisión es `ASK` y exige confirmación independiente. No existe fallback privado/compartido.

La política de sensibilidad es conservadora: solo `sensitivity: none` puede alcanzar elegibilidad hipotética; el resto se deniega para guardado autónomo. Conflictos y reemplazos siempre requieren revisión. `IGNORE` y `DUPLICATE` se deniegan.

## Consentimiento y limitaciones

El contrato de consentimiento incluido en la entrada de la compuerta es una proyección estricta, ficticia y de solo lectura para este ejercicio. Se vincula a principal, sujeto, instalación, épocas, propósito `automatic_memory_autosave`, ámbito, categoría, fecha, expiración, revocación y revisión. No es el consentimiento persistente actual de Automatic Memory: ese consentimiento autoriza únicamente evaluación/análisis futuro bajo su alcance y declara explícitamente que no permite guardar recuerdos. Reutilizarlo para escritura sería ampliar su significado. No se creó un almacén, interfaz de confirmación ni emisor de consentimiento para guardado.

Las revisiones se comparan con valores de snapshot suministrados como datos. La función pura no lee un repositorio ni puede garantizar frescura atómica entre evaluar y escribir. Cualquier sistema futuro necesitará consultar estado confiable y volver a validar identidad, consentimiento, grants, opt-out, política y revisiones dentro de la frontera transaccional.

La clasificación del detector, el planificador B.1, una decisión de C.6.1 o el resultado de esta compuerta no conceden permisos. No se emiten tokens, capabilities, recibos ni IDs de autorización reutilizables. No hay escritor conectado a C.6.2.

## Validación y límites

`test/memory-automatic-c6.2.test.js` usa exclusivamente fixtures sintéticas. Comprueba un caso hipotéticamente elegible, identidad y sujeto faltantes o cruzados, consentimiento ausente/vencido/revocado, opt-out, sesión/dispositivo revocado, revisiones obsoletas, ámbito privado de otra persona, ámbito compartido, sensibilidad, REPLACE, conflictos, fuente de herramienta, solicitudes de ejecución, intento de reutilizar un resultado y la integración no confiable de C.6.1.

Las pruebas incluyen regresiones para consentimiento de evaluación sin alcance de guardado, identidad y principal/instalación cruzados, dispositivo suspendido, sesión anterior tras renovación, promoción de un resultado hipotético favorable a una solicitud de ejecución, y candidatos múltiples con decisiones independientes. Estos tests validan el comportamiento de funciones puras y la ausencia de dependencias de escritura/modelo en esta ruta. No demuestran autenticación, persistencia de consentimiento o grants, revocación durable, concurrencia, atomicidad, seguridad de sistema operativo ni calidad del extractor real. Memory1 permanece como backend; C.6.2 no activa Memory2, el extractor ni el aprendizaje automático.
