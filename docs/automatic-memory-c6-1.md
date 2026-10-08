# Automatic Memory C.6.1 — Simulación de aprendizaje selectivo

## Alcance

C.6.1 agrega una simulación offline del recorrido de evaluación. Solo admite texto y propuestas sintéticas que ya tienen la forma del contrato de Automatic Memory A. No llama a un extractor, no lee historial ni consentimiento real y no conecta con la CLI, el agente, herramientas, MemoryService o repositorios.

El módulo reutiliza `screenAutomaticMemoryTurn`, `getAutomaticMemorySourcePolicy`, la normalización y validación de candidatos, `evaluateAutomaticMemoryPolicy` y el planner B.1. No crea una segunda policy de persistencia. Una comprobación pequeña entre candidatos del mismo turno solo puede degradar conflictos potenciales a `ask`; nunca concede elegibilidad.

## Flujo

```text
fixture sintética no confiable
    → etiqueta de procedencia (solo descriptiva)
    → consentimiento de escenario (solo simulación)
    → filtro de privacidad existente
    → schema y evidencia existente
    → policy A
    → planner B.1
    → resultado simulado, siempre no ejecutable
```

`auto_save_candidate` representa únicamente la disposición favorable de la policy A para una posible consideración futura. El resultado final del planner puede seguir siendo `ASK`, por ejemplo porque una decisión de proyecto es textual y no tiene entidad canónica. `ask` y `ignore` conservan sus significados existentes. La sugerencia del extractor nunca es autoridad.

## Procedencia, identidad y consentimiento

Todos los datos de esta interfaz son fixtures no confiables. `sourceId: "user:direct"` es una etiqueta de escenario y no prueba que el texto provenga de una persona ni de `stdin`. La etiqueta de identidad solo acepta `unverified`; no existe entrada para fabricar un principal autenticado, Self, sesión confiable o capability.

El estado sintético `consentScenario.state: "granted"` sirve únicamente para probar las capas posteriores. No crea ni representa consentimiento real. Los estados `missing` y `revoked`, el opt-out por mensaje y el opt-out de conversación detienen la evaluación. El filtro existente puede detener también mensajes con credenciales, ubicación, citas/importaciones, contenido efímero o instrucciones de inyección. Las fuentes de tools, correo, CRM, web, archivos, asistente y memoria recuperada se rechazan antes de evaluar candidatos.

Sin identidad autenticada no se atribuyen propuestas a Self. Por eso una preferencia estable en primera persona queda en `ASK` con `subject_not_canonically_resolved`, aunque la fixture o el modelo use la palabra `user`. Los hechos de terceros requieren revisión. No hay compartición inferida.

## Resultado y límites

Cada respuesta indica `simulationOnly: true`, procedencia sintética no confiable, clasificación, decisión del planner y reason codes. Los valores y textos de evidencia no se devuelven. La capa de simulación convierte cualquier eventual salida `ADD` o `REPLACE` del planner en `ASK`. Todas las respuestas fijan `authorization.granted: false`, `authorization.executable: false`, `persistence.requested: false` y `persistence.performed: false`; cada operación lleva `writeReady: false`.

El módulo no importa el detector real ni permite inyectar una función extractora, cliente API, writer, repositorio o MemoryService. Las propuestas se pasan como fixtures estructurales. Por diseño, esta etapa no mide calidad del modelo ni implementa análisis conversacional de producción.

## Cobertura

Las pruebas sintéticas cubren preferencias estables sin Self autenticado, decisión textual de proyecto, contenido temporal y sensible, múltiples candidatos, conflictos en un turno, opt-outs, consentimiento ausente o revocado, fuentes externas, hechos de terceros, IDs de entidad falsificados, solicitud de ejecución y ausencia de dependencias de red/escritura.

Memory1 permanece como backend predeterminado y C.6.1 no abre ni modifica ningún store. Memory2 y el extractor real siguen desactivados.

## Pendiente antes de escritura real

Una clasificación favorable nunca será suficiente para persistir. Antes de habilitar escrituras se requiere identidad autenticada y vinculada a Self, consentimiento real verificable y revocable, integración controlada con el coordinador B.2b, revalidación del plan/snapshot y uso de la frontera transaccional autorizada. También quedan fuera de C.6.1 la integración de CLI/agente, cualquier extractor real, gestión de memoria compartida y la activación personal de Memory2.
