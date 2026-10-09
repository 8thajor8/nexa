# Automatic Memory C.6 — Recorrido selectivo simulado

## Alcance

C.6.1 y C.6.2 forman un recorrido de evaluación sintético y no ejecutable. C.6.3 añade pruebas de integración y trazabilidad entre componentes existentes; no agrega un ejecutor, un almacén de consentimiento ni una identidad confiable.

El circuito es:

```text
entrada sintética y propuesta sintética
        ↓
filtro de privacidad y política de fuentes
        ↓
validación de propuesta y evidencia
        ↓
policy determinista
        ↓
planner dry-run, sin snapshot de memoria
        ↓
authorization gate hipotético, con procedencia no confiable e identidad ausente
        ↓
decisión final explicable; sin escritura
```

La propuesta del modelo está representada por fixtures locales. Las pruebas no llaman al extractor ni a OpenAI. La simulación de C.6.1 acepta solo el escenario `user:direct`, pero esa etiqueta es dato de prueba: no demuestra que el texto haya llegado por `stdin` ni autentica a una persona.

## Trazabilidad por candidato

Cada candidato devuelto expone únicamente metadatos y códigos de razón:

- `candidateType` y `policyClassification`/`policyDisposition` muestran la categoría y recomendación de la policy.
- `policyReasonCodes` explican esa recomendación.
- `plannerOperation` y `plannerReasonCodes` muestran lo que propuso el planner.
- `operation` es la operación presentada por la simulación. Si el planner propone ADD o REPLACE, la salida se degrada a `ASK`.
- `authorizationGate` y `finalDecision` muestran la decisión final hipotética y sus razones.
- `writeReady` permanece en `false`; la autorización global sigue denegada y `persistence.performed` permanece en `false`.

No se devuelven el texto original, la evidencia, el valor candidato, identificadores de sesión, identidad, grants o capacidades. La función no escribe logs ni guarda trazas.

## Ejemplos comprobados

Las pruebas sintéticas verifican que:

- Una preferencia estable sin identidad canónica queda para revisión; no se presume Self.
- Un mensaje temporal se descarta en el filtro previo.
- Un hecho sensible puede llegar a la policy como `ASK`, pero el gate deniega la elegibilidad autónoma.
- Una decisión de proyecto puede recibir clasificación favorable de la policy, mientras el planner solicita revisión porque no hay identidad canónica del proyecto; el gate tampoco la eleva.
- Un hecho sobre una tercera persona requiere revisión y no se atribuye a Self.
- Fuentes de tools/CRM y otros orígenes externos se excluyen antes de producir candidatos.
- Opt-out, falta o revocación del consentimiento de análisis detienen el circuito antes de policy/planner/gate.
- La identidad no verificada y los candidatos contradictorios permanecen en revisión.
- Cada candidato de una entrada múltiple conserva su propio resultado; un candidato sensible no cambia la decisión del candidato vecino.
- Una entrada que solicita ejecución no satisface el contrato exacto de simulación. La compuerta C.6.2 deniega el modo de ejecución.

La fixture `consentScenario: granted` solo permite que el harness sintético pruebe la policy. No se pasa al gate como consentimiento para guardar. La compuerta exige un contrato hipotético distinto de propósito `automatic_memory_autosave`; ese contrato aún no tiene emisor ni almacenamiento de producción.

## Garantías demostradas y límites

Las pruebas ejercitan las funciones reales de filtro, normalización, validación, policy, planner y authorization gate con datos sintéticos. Comprueban que el circuito actual no ofrece una escritura, que sus resultados no son ejecutables y que las fuentes externas, opt-outs y datos sensibles no pueden llegar a una decisión de guardado autónomo.

Estas pruebas no demuestran autenticación real, identidad de hablante, consentimiento persistente para guardar, grants de producción, frescura atómica de revisiones, revocación durable, concurrencia, atomicidad, durabilidad física ni precisión de un modelo real. Tampoco demuestran aislamiento de procesos o del sistema operativo.

El planner recibe `snapshot: null` en la simulación integrada. Por ello no puede verificar duplicados o conflictos contra Memory2 ni resolver Self desde un snapshot, y las operaciones que dependerían de ello requieren revisión. La etiqueta de consentimiento sintético tampoco habilita el consentimiento de guardado. Un `ELIGIBLE_HYPOTHETICAL` de una prueba aislada C.6.2 no es autorización reutilizable y no puede promoverse a escritura.

## Requisitos antes de una activación real

Una fase futura tendría que diseñar y probar por separado, como mínimo:

1. Un límite de origen y principal confiable del runtime, sin convertir `stdin`, voz o claims del modelo en autenticación.
2. Consentimiento explícito para análisis y, por separado, una política y consentimiento de guardado con alcance, vigencia y revocación persistentes.
3. Un snapshot de identidad, permisos y memoria obtenido de fuentes confiables y revalidado dentro de la transacción de escritura.
4. Un flujo independiente de confirmación para operaciones que lo requieran, sin texto del modelo como autoridad.
5. Una frontera de escritura que obligue a autorización de un solo uso, atomicidad e idempotencia, además de recuperación documentada.
6. Exclusiones de fuentes y datos sensibles aplicadas antes de cualquier envío externo, con política de retención revisada.
7. Pruebas de extremo a extremo contra almacenamiento temporal real, carreras, fallos e intentos de bypass antes de conectar el agente.
8. Una activación explícita, reversible y inicialmente aislada, aprobada después de revisar privacidad, costos y operación.

C.6 no conecta este circuito al agente, a tools, al extractor real, a MemoryService ni a un repositorio. Memory1 permanece como backend efectivo; Memory2 y Automatic Memory no se activan por esta etapa.
