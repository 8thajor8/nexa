# Memory D.3 — Contradicciones, cambios y resolución conservadora

D.3 añade una proyección determinista y de solo lectura para comparar assertions ya filtradas por una capa superior. Reutiliza `describeTemporalRecord()` de D.1, `compareTemporal()` y, para relaciones, `describeRelation()` de D.2. No modifica Schema v5, el catálogo real de predicados, el repositorio ni el servicio de escritura.

## Contrato

`compareAssertionPair()` evalúa dos assertions ordinarias; `evaluateAssertionSet()` compara por pares un conjunto acotado de hasta 100 registros de un único sujeto, ámbito declarado e instante de referencia; `compareRelationPair()` valida ambos extremos con D.2 y compara únicamente esa pareja directa. Los modos disponibles son `simulate` y `execute`; este último siempre devuelve `DENY` sin evaluaciones. Las proyecciones contienen IDs de assertions, clasificación, reason code, motivos de incertidumbre, nivel de incertidumbre, estado estructural de evidencia y `executable: false` / `persistencePerformed: false`. Nunca devuelven valores, texto de evidencia, nombres, fuentes concretas ni contenido sensible.

Las clasificaciones son:

- `compatible`: mismo valor estructurado; un plan que D.1 clasifica actualmente como `planned` frente a un hecho no se interpreta como cumplimiento. Si la fecha del plan ya llegó, pasó, o su vigencia es desconocida, D.3 devuelve `insufficient_information`: el vencimiento no demuestra que el plan se haya cumplido. Dos planes futuros distintos también requieren aclaración. Para relaciones, un duplicado directo se señala como tal y `partner_of` admite vínculos múltiples según el catálogo real.
- `potential_conflict`: solo se produce cuando una regla explícita aplicable declara exclusividad. El catálogo de Schema v5 no contiene reglas escalares de exclusividad; para probar la ruta, una llamada puede inyectar `syntheticCatalog` con `kind: "synthetic_test_only"` y predicados limitados al namespace `test.*`. Ese catálogo es exclusivamente un instrumento de prueba, no puede aplicar reglas sintéticas a predicados reales y no amplía ni representa el catálogo real.
- `temporal_change`: las assertions comparten un slot de compatibilidad explícito y sus intervalos de vigencia completos son definitivamente disjuntos. Esto describe una separación temporal; no demuestra que el evento ocurriera ni elige cuál valor es verdadero o vigente.
- `superseded`: una assertion activa referencia explícitamente mediante `supersedes` a la otra, cuyo estado es `superseded`.
- `insufficient_information`: no hay regla semántica aplicable, la temporalidad se solapa o es incompleta, un plan no está resuelto, o no se puede sostener una clasificación más fuerte.

Un slot `compatibility` agrupa posibles objetivos de actualización en el servicio, pero **no es por sí mismo una regla semántica de incompatibilidad**. Valores distintos en el mismo slot no producen `potential_conflict` sin una regla de exclusividad aplicable. El validador del catálogo sintético rechaza reglas repetidas, semánticas desconocidas y cualquier predicado fuera de `test.*`; esas reglas solo pueden ejercitar la ruta de prueba y no cambian el catálogo real. Fuentes o derivaciones distintas tampoco prueban contradicción: el esquema conserva metadatos de procedencia, no el contenido independiente de cada evidencia necesario para adjudicar verdad.

## Temporalidad y relaciones

D.1 conserva la precisión de año, mes, día e instante. D.3 declara `temporal_change` únicamente cuando `compareTemporal()` demuestra que los intervalos no se solapan; una frontera igual o fechas parciales ambiguas no bastan. La comparación es independiente del orden de propiedades de los objetos temporales. No usa la fecha de registro como fecha del hecho.

`intent: "plan"` continúa siendo una interpretación del llamador, no un campo persistido. Un plan futuro no se convierte en hecho cuando llega su fecha. D.3 solo lo trata como plan futuro mientras D.1 lo clasifique como `planned`; si D.1 informa estado desconocido porque la fecha llegó o la ventana venció, D.3 devuelve `insufficient_information` con `plan_outcome_unconfirmed`. Dos planes futuros diferentes requieren aclaración. Una vista de cancelación producida por `planTemporalTransition()` tampoco equivale a un estado cancelado almacenado: si se presenta, D.3 devuelve `insufficient_information` con `cancellation_preview_not_persisted`.

D.2 valida las relaciones contra el catálogo real, que actualmente define únicamente `partner_of`, simétrica y de cardinalidad múltiple. D.3 no infiere transitividad, no inventa predicados dirigidos ni exclusividad, y no concluye que dos entidades están relacionadas indirectamente. Las reglas futuras requieren una decisión y una ampliación explícita del catálogo en una fase posterior.

## Privacidad y límites

Los registros de Schema v5 no permiten verificar por sí solos autorización, partición física ni ámbito de memoria. El llamador debe seleccionar primero un conjunto autorizado y de una sola partición. D.3 compara etiquetas de ámbito declaradas para rechazar mezclas detectables; esas etiquetas no autentican, no autorizan y no garantizan aislamiento. La función rechaza sujetos distintos, tiempos de referencia diferentes, IDs duplicados y etiquetas de ámbito incompatibles. En conjuntos, el llamador entrega una etiqueta por registro para que las discrepancias declaradas sean detectables.

Las funciones son puras respecto al repositorio: no leen ni escriben archivos, no ejecutan `ADD`, `REPLACE` o `DELETE`, no emiten permisos, no identifican Self y no se conectan al agente, CLI ni Automatic Memory. La evidencia estructural aparece como `structurally_linked_unverified`; la capa no verifica la verdad de una afirmación ni convierte procedencia en identidad autenticada. Una llamada no puede garantizar consumo único ni proteger contra snapshots antiguos reintroducidos por un llamador.

## Validación

Las pruebas usan fixtures sintéticas para valores compatibles, slots distintos, reglas de exclusividad sintéticas válidas e inválidas, intervalos disjuntos y parciales (incluidos objetos equivalentes con orden de propiedades distinto), supersession, planes futuros, vencidos y cancelaciones hipotéticas, procedencia no concluyente, relaciones directas, cardinalidad múltiple, orden determinista, mezcla de sujetos/ámbitos, duplicados, entradas malformadas y modo de ejecución denegado. Estas pruebas no demuestran autenticación, aislamiento de almacenamiento, autorización, durabilidad ni resolución de contradicciones en producción.

Memory1 sigue siendo el backend efectivo; Memory2 y Automatic Memory permanecen desactivadas. D.3 no activa Memory2, no migra datos, no realiza llamadas a OpenAI y no modifica recuerdos personales.
