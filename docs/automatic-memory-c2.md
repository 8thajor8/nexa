# Automatic Memory C.2 — Evaluación conversacional experimental

## Alcance y estado

C.2 conecta una interfaz de evaluación posterior a la respuesta dentro del agente, pero permanece **apagada por defecto**. La instancia actual de Nexa (`src/index.js`) no configura ni inyecta detector: el flag no está en `config`, no viene de `.env` y no existe un fallback a `createAutomaticMemoryDetector()` o a OpenAI. Esta etapa no incorpora planner, coordinador, writer, repository ni persistencia automática al agente.

En pruebas se inyecta un detector sintético. El contrato de la interfaz es `detect({ text })`; el resultado se descarta y no se devuelve al modelo, a las tools ni al usuario. La interfaz solo prueba el orden y los límites del hook; no mide calidad de extracción ni llama al modelo real.

## Implementación

`createAgent()` acepta `enableAutomaticMemoryAssessment` (default `false`) y `automaticMemoryDetector` (default `null`). C.3 añade un requisito separado: consentimiento de sesión válido, solicitado y confirmado por comandos de stdin. El flag sin detector falla al crear el agente; el flag más detector sin consentimiento no evalúa. No se selecciona extractor implícito. La aplicación CLI no pasa estas opciones, así que su consentimiento no activa análisis ni envíos.

Solo `readAndRun()` puede programar evaluación: toma el texto del objeto entregado por `readDirectUserTurn()` y lo conserva temporalmente en estado privado después de que el ciclo normal del modelo termine. No guarda el objeto de turno ni sus capabilities. Los comandos explícitos, mensajes vacíos, turnos que terminan en `salir` y errores del modelo no programan evaluación. `agent.run(text)` no lo hace.

El CLI imprime primero la respuesta. Después invoca `completePresentedTurn()` sin argumentos y espera su finalización antes de iterar hacia otra lectura de stdin. El método consume el único pendiente antes de llamar al detector, así que una segunda llamada no repite el análisis. Si el host lee otro turno sin completar la fase previa, el pendiente se descarta en vez de competir por stdin o ejecutarse antes de presentar la respuesta. El detector no lee stdin.

La evaluación recibe `{ text: mensajeOriginal, signal }`. No recibe historial, salida del assistant, `function_call`, arguments/resultados de tools, contexto recuperado, command proof, runtime capability, autorización, objeto de agente ni repositorio. Un filtro C.3 previo a guardar el turno como pendiente omite entradas bloqueadas y devuelve/loguea solo códigos fijos. El agente no importa Automatic Memory writer, autorización automática ni repositorio. La función inyectada no puede cambiar la respuesta ya producida: errores se convierten en códigos seguros sin texto privado en el log o resultado.

## Flujo

```mermaid
sequenceDiagram
    participant U as stdin
    participant A as Agent / readAndRun
    participant M as modelo conversacional simulado/normal
    participant CLI as src/index.js
    participant D as detector inyectado

    U->>A: turno directo original
    A->>M: ciclo conversacional existente
    M-->>A: respuesta y posibles tools
    A-->>CLI: respuesta final
    CLI-->>U: imprime respuesta
    CLI->>A: completePresentedTurn() sin argumentos
    A->>D: detect({text: solo el turno original})
    D-->>A: resultado descartado o error sanitizado
    A-->>CLI: estado sin candidato ni capability
    CLI->>U: permite siguiente readAndRun()
```

Este flujo no llama al detector real en C.2 normal y no crea una autorización, propuesta persistida ni escritura.

## Configuración experimental

La activación requiere ambas condiciones explícitas en composición de código:

```js
createAgent({
  enableAutomaticMemoryAssessment: true,
  automaticMemoryDetector: syntheticOrSeparatelyApprovedDetector,
});
```

No existe una variable de entorno para activar C.2. No se debe pasar el detector real de `src/memory/automatic/detector.js` hasta una fase aprobada de privacidad y extractor. La configuración de producción actual llama a `createAgent()` sin estos argumentos, de modo que no se realiza ningún análisis adicional ni llamada de red.

## Pruebas y garantías observadas

`test/memory-automatic-agent-assessment.test.js` ejecuta procesos hijos con entrada sintética real por stdin, `ask` simulado y detector inyectado:

- la opción está desactivada por defecto incluso si hay un detector simulado disponible;
- el mensaje directo original se analiza una vez tras la respuesta visible;
- tools y texto de `agent.run()` no entran al detector;
- llamar dos veces a `completePresentedTurn()` no duplica el análisis;
- una segunda lectura de stdin ocurre después de finalizar o descartar el pendiente, sin un segundo lector de confirmación;
- un error del detector no cambia respuestas, no escribe y no expone detalles de error;
- un error del agente deja el turno sin evaluación y no impide evaluar el siguiente turno completo;
- las respuestas del modelo marcadas `incomplete` no programan evaluación, aunque el comportamiento conversacional existente siga mostrando su texto parcial;
- si el detector queda pendiente, la respuesta ya se entregó, pero la cola del agente mantiene en espera los turnos siguientes;
- cerrar el agente durante una evaluación en curso no cancela la promesa del detector;
- no se permite habilitar la opción sin dependencia inyectada;
- la CLI presenta la respuesta antes de llamar al hook;
- no se importan coordinator ni writer desde el agente.

Las pruebas no llaman a OpenAI: `ask` y detector son stubs. No se inspecciona ni persiste una conversación personal, no se crea ningún store v2 y no se escribe Memory1. El hook descarta deliberadamente el resultado, incluidos candidatos; por lo tanto no prueba una interfaz de usuario para propuesta/confirmación ni una integración de policy/planner.

La elegibilidad de evaluación requiere que cada respuesta de Responses API observada durante el ciclo tenga `status: "completed"` y que se haya producido una respuesta textual no vacía. Si una respuesta no tiene estado, queda incompleta o falla el modelo, el agente conserva su comportamiento conversacional existente y omite la evaluación.

## Límites y privacidad

- En la configuración actual el número de llamadas extra a OpenAI por C.2/C.3 es cero. El mecanismo de A, si se inyectara explícitamente en una etapa futura y hubiera consentimiento válido, realizaría un envío adicional del texto al modelo configurado. No queda autorizado por este cambio.
- El screening de credenciales de A es heurístico y la sensibilidad semántica se determina después de la extracción. No garantiza que todo secreto o dato sensible se mantenga local. La detección real necesita decisión explícita sobre aviso, consentimiento, categorías prohibidas, retención y coste.
- El hook es de evaluación únicamente. `auto_save` no equivale a autorización. ASK, IGNORE, DUPLICATE, ADD y REPLACE no se muestran ni escriben en esta fase; no hay confirmación ni capability nueva.
- No se crea autoridad de turno nueva: la elegibilidad nace solo del camino `readDirectUserTurn()` → estado privado de `readAndRun()`. El hash/turno no se acepta como claim de `agent.run()` ni de tools.
- El modelo puede usar tools en el ciclo conversacional normal, como antes; C.2 no envía el candidato ni el resultado del detector a tools. Este alcance no cambia las otras políticas de datos del agente.
- El flag está disponible para hosts que construyen `createAgent()` y el objeto `detect` es una dependencia de código. No es una frontera contra ejecución arbitraria de módulos dentro del mismo proceso. La aplicación CLI no habilita ese camino.
- C.3 limita la espera a 5 segundos por defecto y pasa `AbortSignal`. Al timeout se libera la cola y se ignora cualquier resultado tardío. Un detector no cooperativo puede conservar su trabajo; se limita a una sola evaluación en vuelo y se omiten nuevos análisis hasta que termine o cierre el proceso. El cierre/revocación aborta un detector cooperativo; no destruye a la fuerza un detector no cooperativo. La integración real requiere revisar que el transporte subyacente respete cancelación.

## Condiciones antes de habilitar el extractor real

1. Resolver privacidad y consentimiento para el envío adicional; definir qué mensajes/categorías no se transmiten.
2. Verificar timeout/cancelación con el transporte concreto: C.3 pasa `AbortSignal` y limita la espera a 5 s, pero no puede terminar a la fuerza un detector no cooperativo.
3. Aprobar una composición explícita y controlada del detector real; jamás usar `auto_save` como permiso.
4. Mantener clasificación, planner y coordinator separados; en una etapa posterior exigir confirmación independiente para cada ADD y REPLACE.
5. Mantener la serialización de stdin y retención efímera de texto estrictamente acotada; verificar EOF, error, cierre y turnos concurrentes.
6. Probar integración completa con extractor simulado, sin repositorio personal, y repetir revisión de seguridad antes de cualquier persistencia experimental.
7. Memory1 sigue siendo backend efectivo; cualquier uso de Memory2 requiere fixture temporal en etapa separada. Activación o migración personal exige autorización posterior explícita.

## Resultado

C.2 deja un hook post-respuesta para evaluación inyectable, desactivado en la CLI normal. C.3 añade consentimiento de sesión, screening previo y un límite de espera con cancelación cooperativa; un detector no cooperativo puede continuar en segundo plano, aunque su resultado se invalida y no se aceptan evaluaciones posteriores mientras siga en vuelo. El extractor real continúa desconectado. La respuesta conversacional ya producida no se altera, no se crea autoridad nueva y no se trasladan capabilities al modelo/tools.

## Validación de cierre

- C.2/C.3 y ensamblado de contexto: 30/30 pruebas.
- Automatic Memory: 87/87 pruebas.
- Memory: 309/309 pruebas.
- Suite completa: 502/502 pruebas en la ejecución con permiso para iniciar Chromium. La ejecución restringida produjo 501/502 por `spawn EPERM` en la prueba existente de audio/voz.
- `git diff --check`: limpio.
- No se hicieron llamadas reales a OpenAI ni escrituras de memoria. Memory1 permaneció intacta; Memory2 continuó desactivada y no se creó un store personal. La configuración actual de la CLI no inyecta el detector, así que el número de llamadas adicionales por Automatic Memory es cero.
