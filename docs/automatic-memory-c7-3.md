# Automatic Memory C.7.3 — recorrido integral simulado

## Alcance

C.7.3 verifica con fixtures sintéticas el recorrido existente entre evaluación selectiva C.6, propuesta efímera C.7.1 y coordinación de respuestas C.7.2. No añade lógica de producción: compone las funciones existentes en pruebas y documenta sus límites. No conecta el circuito al agente, CLI, extractor real, tools, coordinador B.2b ni escritores.

## Recorrido probado

```text
texto y candidato sintéticos
        ↓
C.6: filtros de privacidad/fuente, validación, policy, planner y gate
        ↓
C.7.1: propuesta individual no ejecutable
        ↓
presentación del conjunto en el orden canónico
        ↓
C.7.2: respuesta estructurada por ID u ordinal y revisión
        ↓
resultado independiente: confirmación hipotética, rechazo, pendiente,
aclaración, vencimiento, revocación o denegación
```

Las pruebas conservan separados el resultado del gate C.6 y la respuesta a la propuesta. Una clasificación o consentimiento sintético para analizar solo permite recorrer la evaluación; no concede consentimiento de almacenamiento. Una afirmación sintética confirma, como máximo, la propuesta personal no sensible exactamente referenciada. Rechazo, respuesta parcial, cancelación, aclaración, corrección, ámbito restringido, ámbito compartido, sensibilidad, vencimiento, revocación, opt-out y revisión obsoleta permanecen no ejecutables.

La traza expone categorías, intenciones estructuradas válidas, estados y códigos de razón. Un valor de intención inválido se omite (`responseIntent: null`) y no se copia desde la entrada; no registra texto original, respuestas textuales ni logs persistentes, y los resúmenes sensibles permanecen ocultos. La entrada `user:direct` y los vínculos de principal/sesión/instalación son fixtures no verificadas, no autenticación.

## Evidencia

Las pruebas de C.7.3 recorren C.6 → C.7.1 → C.7.2 con candidatos ficticios y cubren confirmación individual y múltiple, confirmación más rechazo, respuestas parciales, identidad/instalación incorrectas, orden ordinal cambiado, revisiones obsoletas, vencimiento, revocación, corrección con propuesta nueva, sensibilidad, opt-out, falta de consentimiento de análisis, fuente externa, replay de snapshot anterior y solicitud de ejecución. C.7.1/C.7.2 mantienen pruebas unitarias específicas para target de REPLACE, respuesta duplicada y referencias de otro lote.

En todas las salidas `authorization.granted` es `false`, `executable` y `writeReady` son `false`, y `persistence.performed` es `false`. Una decisión `confirmed_hypothetically` representa el resultado de una fixture, no permiso ni consentimiento real de guardado. La función de lote devuelve la intención estructurada en `responseIntent`, el resultado en `responseOutcome` y la propuesta con su estado actualizado.

## Replays y límites

El estado y las revisiones son sintéticos y se pasan en cada llamada. El snapshot actualizado rechaza una propuesta resuelta. Una copia antigua todavía puede producir otra confirmación hipotética, pero nunca una autorización ejecutable. La comprobación de `presentedProposalIds` evita que un cambio accidental del orden o composición presentado reasigne ordinales; como el llamador controla ese valor, no es una prueba autenticada ni un sello durable.

Una integración real necesitará verificar identidad y consentimiento desde fuentes confiables, mantener estado autoritativo, revisar vencimientos/revocaciones y consumir propuesta y respuesta atómicamente bajo revisión vigente antes de cualquier autorización independiente y transacción de escritura. Estas pruebas no demuestran autenticación, persistencia, concurrencia, atomicidad, durabilidad, ni calidad de un extractor real.

Memory1 continúa como backend efectivo. Memory2, Automatic Memory real y el extractor real permanecen desactivados. C.7.3 no realiza llamadas a OpenAI ni escribe recuerdos.
