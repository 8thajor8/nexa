# Automatic Memory C.7.2 — coordinación simulada de propuestas múltiples

## Alcance

C.7.2 extiende el módulo C.7.1 con `evaluateSimulatedMemoryConfirmationBatch()`. Recibe una colección explícita de propuestas y respuestas estructuradas sintéticas, usa el contrato individual existente para cada respuesta y devuelve decisiones independientes. No integra agente, CLI, extractor real, herramientas, cola persistente, coordinador B.2b ni escritor.

No duplica consentimiento ni autorización: se conservan las reglas individuales C.7.1 y el gate hipotético de C.6. Opt-out y revocación de consentimiento prevalecen sobre respuestas. Una aprobación hipotética no equivale a consentimiento real para almacenar, grant ni permiso.

## Estado y referencias

El llamador pasa el snapshot sintético de propuestas y una lista `currentRevisions` completa y única. Cada registro conserva su ID, candidato/assessment, fingerprint, operación, target, vínculo estructural, ámbito, sensibilidad, estado, revisión y vencimiento. Se rechazan lotes con IDs duplicados, referencias de candidato duplicadas, contexto mezclado de principal/sesión/instalación, revisiones repetidas o incompletas y solicitudes de ejecución.

Las respuestas pueden apuntar por `proposal_id` o por ordinal. El orden ordinal es determinista y reproducible: `createdAt` ascendente y, en empate, `proposalId` ascendente. El resultado devuelve `orderedProposalIds`; al procesar respuestas, el llamador debe devolver ese orden como `presentedProposalIds`. Si la composición u orden cambió desde la presentación, el lote entero falla cerrado en vez de reasignar un ordinal. Esto detecta desajustes accidentales entre presentación y evaluación, pero el campo es sintético y controlado por el llamador; no es una prueba confiable ni un sello persistente. Ordinales fuera de rango o referencias inválidas generan un issue y no confirman ninguna propuesta; varias respuestas dirigidas a la misma propuesta se rechazan para esa propuesta.

Una respuesta ausente deja la propuesta sin resolver. Las respuestas presentes se procesan una a una por `evaluateSimulatedMemoryConfirmation()`, manteniendo los controles exactos de propuesta, candidato, huella, operación, target, principal, sesión e instalación. Una referencia que pertenece a otra colección no se resuelve; las revisiones actuales deben estar completas, ser únicas y coincidir con cada propuesta. Por ello, una afirmación confirma hipotéticamente solo su propuesta referenciada. Una respuesta estructurada `correct` o `request_clarification` deja la propuesta en revisión y exige volver a evaluar/recrear una propuesta; no se altera la afirmación ni se persiste el contenido corregido en esta etapa. No se interpreta texto natural. Los cambios, solicitudes de compartir, datos sensibles y ámbitos que requieren revisión conservan el comportamiento conservador individual.

`cancelBatch` cierra las propuestas pendientes o en aclaración del lote. `optOut` y `consentRevoked` revocan antes de considerar respuestas. Los elementos vencidos quedan `expired`. Las decisiones anteriores no se reinterpretan como autorización.

## Replays y límites

El estado actualizado es explícito: cada salida devuelve propuestas con su estado y revisión resultantes. Si ese snapshot actualizado se reutiliza, una propuesta ya consumida se rechaza. Como el coordinador es puro y no guarda estado, un llamador puede reintroducir un snapshot `pending` antiguo y obtener de nuevo una decisión `confirmed_hypothetically`; las pruebas comprueban que sigue sin `authorization.granted`, ejecutabilidad ni persistencia. C.7.2 no afirma consumo único ni protección real contra replay.

Una integración futura requerirá almacenamiento autoritativo, control de revisión vigente y consumo atómico del estado/propuesta, junto con verificación de la identidad real del respondedor. Las referencias ordinales solo son seguras si la interfaz presenta el orden canónico devuelto; texto natural, palabras como «primera» o «segunda» no se interpretan aquí.

## Privacidad y garantías

Los resultados contienen IDs opacos, códigos de razón y resúmenes ya limitados por el contrato C.7.1; no incluyen texto original ni respuestas textuales. Los resúmenes sensibles permanecen nulos. No hay logging. Las fixtures de principal, sesión e instalación son estructurales, no autenticación.

Las pruebas usan exclusivamente candidatos sintéticos y cubren confirmaciones independientes, rechazo, respuestas parciales, ordinales, duplicados, referencias cruzadas, identidades/instalaciones mezcladas, correcciones, ámbitos, compartir, cancelación, vencimiento, revocación, opt-out, sensibilidad, replay y solicitud de ejecución. Ningún resultado puede autorizar escrituras. No se demuestra autenticación, interpretación lingüística, almacenamiento, concurrencia, consumo atómico ni durabilidad.
