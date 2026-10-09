# Automatic Memory C.7.1 — contrato simulado de confirmación conversacional

## Alcance

C.7.1 añade dos funciones puras para representar una propuesta efímera derivada de una evaluación C.6 y evaluar una respuesta sintética vinculada a una sola propuesta. No conecta el flujo al agente, a la CLI, a herramientas, a la cola local ni a ningún escritor.

El módulo reutiliza la evaluación de C.6 y `isHypotheticalAutomaticMemoryGateDecision()` para exigir una salida hipotética y no ejecutable. Usa también el filtro existente de secretos para rechazar resúmenes con patrones de credenciales. No añade otro motor de consentimiento: el consentimiento de C.5/C.6 permite evaluar un turno para posibles candidatos; no equivale a consentimiento para guardar. `optOut` y `consentRevoked` son entradas de estado de la simulación y prevalecen.

## Contrato

`createSimulatedMemoryConfirmationProposal()` recibe una sola evaluación de candidato, huella, operación del planner, resumen acotado, ámbito sugerido, motivo, sensibilidad, target exacto para `REPLACE`, vinculación declarada (sesión, principal, instalación y turno) y vencimiento. Devuelve un objeto inmutable con estado `pending`, revisión y `executable: false`. El enlace de sesión, principal, instalación y turno se marca siempre `bindingStatus: unverified` y `fixtureOnly: true`; son metadatos de fixture, no identidad autenticada.

Los candidatos sensibles omiten completamente el resumen. Una respuesta afirmativa no los confirma: quedan en aclaración para revisión independiente. `REPLACE` conserva la referencia exacta del target. Las propuestas compartidas o de proyecto necesitan una nueva propuesta con los requisitos específicos correspondientes; una solicitud de compartir nunca amplía el ámbito actual.

`evaluateSimulatedMemoryConfirmation()` acepta un solo intento con los identificadores, huella, operación y target de esa propuesta. También compara principal, sesión e instalación con los metadatos no verificados de la propuesta. Una afirmación no sensible y de ámbito personal puede producir únicamente `confirmed_hypothetically`. Rechazo y cancelación cierran esa propuesta. Correcciones, cambio de ámbito, solicitud de compartir, respuestas ambiguas o no relacionadas requieren aclaración; las correcciones exigen crear una nueva propuesta. Un principal, sesión o instalación distintos, una operación, target o huella diferente, una revisión desactualizada, una propuesta resuelta/vencida/revocada u opt-out producen denegación, vencimiento o revocación. No existe operación por lotes ni un «sí» que abarque candidatos múltiples.

La interfaz usa intenciones estructuradas sintéticas como `affirm` y `reject`; no interpreta lenguaje natural. `sourceLabel: synthetic_direct_user` es solo un dato de fixture y el validador lo acepta únicamente para probar el contrato. No es prueba de origen directo ni puede autenticar a una persona. La función no confía en IDs de usuario, sesión, turno, voz, SID o etiquetas como autoridad.

## Revisión, replay y privacidad

Las propuestas son valores en memoria y las funciones no guardan estado. El llamador puede transportar la nueva revisión retornada para rechazar el uso accidental de una propuesta ya resuelta, lo cual prueban las regresiones. Sin un registro autoritativo de estado no se puede impedir que un caller reconstruya o vuelva a presentar una copia antigua `pending`; por tanto, C.7.1 no afirma protección de replay o consumo durable de respuestas. Una futura integración deberá consultar y actualizar estado de forma atómica en un coordinador confiable, verificar el turno y el principal en la frontera real, y ligar cada confirmación a una única propuesta antes de emitir una autorización B.2b nueva e independiente.

El resumen tiene máximo 240 caracteres, no admite saltos de línea/control y pasa por el detector de secretos. No se devuelven los textos originales ni las respuestas textuales, ni se escriben logs. La clasificación de sensibilidad y el resumen siguen siendo datos suministrados al contrato simulado: el módulo no puede probar que un productor futuro los haya clasificado correctamente. Para datos sensibles no se incluye resumen y nunca se acepta confirmación automática en esta etapa.

## Garantías comprobadas y límites

Las pruebas sintéticas cubren afirmación, rechazo, corrección seguida de una afirmación al hecho antiguo, restricción y solicitud de compartir, ambigüedad, respuestas no relacionadas, candidatos múltiples, bindings cruzados, principal/sesión/instalación incorrectos, operación/huella/target alterados, vencimiento, revisión obsoleta, opt-out, revocación, sensibilidad, `REPLACE`, replay con estado actualizado y replay de una copia antigua. La copia antigua puede repetirse en esta función sin estado y producir el mismo resultado hipotético; la regresión demuestra que ese resultado continúa sin permiso ni ejecutabilidad. Todas las salidas exitosas mantienen `authorization.granted: false`, `executable: false`, `writeReady: false` y `persistence.performed: false`. El módulo no importa agente, API de OpenAI, coordinador de autorización, servicio/repositorio ni cola persistente.

Estas pruebas no demuestran autenticación real, consentimiento real para guardar, interpretación de texto, almacenamiento, consumo de un solo uso, concurrencia ni durabilidad. Memory2 y Automatic Memory permanecen desactivadas; C.7.1 no ejecuta escrituras, llamadas a OpenAI ni modificaciones de recuerdos.
