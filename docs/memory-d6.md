# Memory D.6 — Recuperación contextual segura

## Estado

D.6 añade una consulta determinista y exclusivamente simulada sobre un conjunto acotado de registros que el llamador ya filtró. El módulo no abre repositorios, no obtiene identidad, no decide permisos y no está conectado al agente ni a la CLI. No activa Memory2 ni Automatic Memory.

## Recorrido

`snapshot sintético ya autorizado por el llamador → validación estructural → exclusiones D.5 suministradas como fixture → selección por campos exactos → temporalidad D.1 → relaciones directas D.2 → señales de conflicto D.3 y duplicidad D.4 → ranking estable → proyección sin valores de hechos`

La API `retrieveContext()` acepta hasta 100 registros y limita la salida a 20 hechos y 10 relaciones. La consulta usa sujeto, IDs de entidades, predicados y una clase temporal estructurados; no hace búsqueda semántica ni compara texto libre. Como las condiciones estructuradas son filtros exactos, la puntuación no pretende estimar la verdad: solo da una prioridad temporal fija a hechos vigentes cuando la consulta admite varios estados. No usa actualidad de registro, valores, evidencia, categorías sensibles ni similitud para ordenar. Los empates se resuelven por ID, así que cambiar el orden de entrada no cambia el resultado. Cada puntuación se marca como `structural_relevance_not_truth_confidence`.

D.1 distingue hechos actuales, históricos, futuros y desconocidos; los planes no se convierten en acontecimientos cumplidos cuando vence su fecha. D.2 aporta relaciones directas y sus reglas explícitas de dirección/simetría; D.6 no recorre un segundo enlace ni infiere transitividad. D.3 aporta comparaciones conservadoras: no escoge un ganador y la ausencia de una regla explícita no prueba contradicción ni compatibilidad. D.6 expone por separado las comparaciones no compatibles y reserva `conflicts` para `potential_conflict`; dos valores distintos sin regla autorizada permanecen como `insufficient_information`. D.4 identifica duplicados o evidencia adicional sin fusionar ni retirar filas. D.5 aporta la forma de restricciones hipotéticas por assertion; D.6 excluye de esta proyección una assertion cuando el snapshot sintético declara `retrieval`, `context` o `sharing` para ese ID. La restricción `learning` no es una prohibición de lectura y debe aplicarse en el flujo de aprendizaje que corresponda.

## Privacidad y límites de confianza

El llamador debe aplicar autenticación, autorización, filtrado por partición, ámbito, sujeto y destinatario **antes** de invocar D.6. `scopeLabel`, IDs, sujeto estructural y `fixtureOnly` son datos declarativos: no autentican a nadie ni demuestran aislamiento. Si la entrada mezcla etiquetas de ámbito, D.6 la rechaza, pero una etiqueta uniforme no demuestra que el conjunto sea legítimo ni completo. No se afirma aislamiento físico de almacenamiento.

Las restricciones D.5 aún no cuentan con un almacén autoritativo conectado; el snapshot de restricciones de D.6 es solo una fixture no persistente. La función no puede descubrir restricciones omitidas por el llamador ni garantizar que una restricción siga vigente. El filtrado previo es necesario para evitar filtraciones indirectas por resultados, conteos, conflictos o duplicados.

La proyección expone IDs de assertions/evidencia, predicados, referencias estructurales de sujeto y endpoints de relaciones, estados temporales y códigos de motivo. No expone valores textuales de hechos ni contenido de evidencia. Los IDs siguen siendo referencias estructurales y deben tratarse según la política de privacidad del consumidor. No se generan logs ni se persisten resultados.

## Seguridad y efectos

- `mode: "execute"` devuelve `DENY` y listas vacías.
- Todas las salidas simuladas tienen `executable: false` y `persistencePerformed: false`.
- No hay llamadas a repositorios, escritores, OpenAI, agente ni tools.
- El módulo no concede permisos, no resuelve Self y no convierte una clasificación en autorización.
- No modifica fixtures, aserciones ni memoria.
- No elige automáticamente una versión cuando existen conflictos; los marca para revisión.

La función es sin estado. No garantiza frescura del snapshot, revocación atómica, consumo único, prevención de replay ni concurrencia. Una futura integración requiere primero identidad autenticada y particiones autorizadas, restricciones y revocaciones autoritativas, una revisión de snapshot verificable, y una frontera transaccional independiente. Esta fase no implementa ninguno de esos mecanismos.

## Cobertura

Las pruebas usan fixtures ficticias y verifican selección exacta, ranking determinista, filtros temporales, planes, conflictos, duplicados, relaciones directas sin traversía, restricciones hipotéticas, mezcla de ámbitos, referencias temporales, IDs duplicados, modo de ejecución denegado e inmutabilidad. No son evidencia de autenticación, autorización, aislamiento de producción, calidad de recuperación con datos personales ni durabilidad.
