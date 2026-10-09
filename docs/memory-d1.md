# Memory D.1 — Temporalidad, vigencia e historial

## Alcance

D.1 añade una capa temporal determinista y de solo lectura sobre los records Memory2 existentes. No cambia Schema v5, no crea almacenamiento paralelo, no escribe en repositorios y no se conecta al agente, a la CLI ni a Automatic Memory. Las operaciones de cambio devuelven previews no ejecutables para fixtures.

## Lo que ya existía

Memory2 ya tenía:

- `assertions.valid_from` / `valid_to` con precisión `year`, `month`, `day` o `instant`, más intervalos abiertos y validación de estructura.
- `assertions.status` (`active`/`superseded`), `supersedes` y `recorded_at`.
- `sources.occurred_at` y `sources.recorded_at`; `evidence.learned_at` y `last_confirmed_at`.
- `currentKnowledge`, `knowledgeValidAt` e `history` en el retriever y MemoryService. Las consultas de validez conservan indeterminación cuando la precisión se solapa; el historial existente conserva registros activos y superseded.
- Reemplazo explícito que conserva la assertion anterior y la vincula por `supersedes`.

Ese modelo es valid-time, no bitemporal. `recorded_at` no reconstruye qué conocía Nexa en una revisión anterior. `currentKnowledge` considera actual una assertion activa sin límites de validez; eso expresa el lifecycle del record, pero no aporta fechas reales. D.1 mantiene esa API intacta y su nueva vista etiqueta la vigencia temporal sin límites como desconocida.

En el código actual, los flujos manuales suelen asignar `sources.occurred_at` y `recorded_at`, y `evidence.learned_at`, con el mismo instante de creación. Por ello `sources.occurred_at` no se puede reinterpretar como fecha real del hecho. D.1 lo expone solo como tiempo de la fuente. La fecha real del acontecimiento no tiene un campo propio en la assertion existente. El tiempo de recepción usa `evidence.learned_at` como marca disponible de cuándo Nexa aprendió el hecho; no garantiza precisión de transporte por separado. La hora de registro permanece `assertions.recorded_at`.

## Implementación

`src/memory/temporal.js` ahora exporta `compareTemporal(a, b)`, que compara intervalos según la precisión original y devuelve `before`, `after`, `equal` u `overlap`; nunca refina año/mes/día a una fecha inventada.

`src/memory/temporal-semantics.js` contiene funciones puras:

- `previewTemporalEntry(...)` valida y clasifica un preview con fechas de vigencia, acontecimiento explícito, recepción, registro y propósito `fact` o `plan`. No asigna ID, identidad, provenance ni estado persistente.
- `describeTemporalRecord(...)` valida assertion/source/evidence existentes, comprueba sus vínculos y deriva `current`, `historical`, `planned`, `future_fact` o `unknown`. Mantiene evento real como no registrado y no confunde `source.occurred_at` con él.
- `summarizeTemporalState(...)` resume un conjunto temporal proporcionado por el caller. Rechaza subjects distintos o IDs de assertion duplicados para evitar agregar estados de personas diferentes. Si hay valores distintos vigentes para el mismo sujeto estructural y predicate, reporta cantidad de slots ambiguos e IDs de assertions afectados, sin copiar el sujeto al resumen; no elige por recencia ni implementa la resolución D.3. Todas las entradas deben compartir el mismo `asOf`.
- `orderTemporalHistory(...)` proyecta el historial validado en orden estable por `recorded_at` e ID y rechaza subjects mezclados o IDs duplicados.
- `planTemporalTransition(...)` produce una vista hipotética de reemplazo o cancelación de un plan futuro exacto. Una cancelación debe preceder a su `valid_from`. No cambia el status ni almacena una cancelación.

Todos los previews y resúmenes indican `executable: false` y `persistencePerformed: false`. Cualquier escritura futura sigue necesitando las fronteras de autorización y repositorio existentes; esta capa no concede permisos.

## Semántica y límites deliberados

- Un hecho solo se etiqueta temporalmente actual cuando su intervalo lo respalda. Fechas ausentes o precisión que se solapa quedan desconocidas.
- Una vigencia futura no convierte por sí sola una assertion en plan. Solo la anotación explícita `intent: plan` permite mostrar `planned`.
- Cuando llega la fecha de un plan, D.1 lo deja desconocido (`plan_due_not_completion_evidence`). No afirma que se haya realizado.
- Un plan cancelado y una transición a histórico aparecen únicamente como resultado de simulación. Schema v5 no contiene lifecycle `planned`/`cancelled` y D.1 no pretende persistirlos.
- Un reemplazo conserva la historia existente solo si en el futuro una operación autorizada realiza el cambio mediante MemoryService/repositorio. El preview no lo hace.
- La evaluación temporal no elige particiones, no resuelve Self ni concede acceso a datos privados. Antes de llamar estas funciones, el caller debe filtrar con una autorización vigente a una sola partición y ámbito; las assertions no llevan información suficiente para que D.1 compruebe si se mezclaron registros private/shared. Los resúmenes e historiales rechazan más de un subject, pero esto no constituye control de acceso ni aislamiento de almacenamiento.
- La fecha de recepción y la de registro pueden ser distintas en fixtures; el preview rechaza registro anterior a recepción. El almacenamiento actual no garantiza que todos los callers las registren de manera distinta ni que ambas capturen un reloj confiable.
- Esta etapa no crea bitemporalidad, tareas/eventos, recurrencia, zona horaria implícita, importación temporal ni reconciliación de contradicciones.

## Cobertura sintética

`test/memory-temporal-semantics.test.js` cubre comparación por precisión, offsets no normalizados rechazados por el esquema UTC existente, hecho actual e histórico, plan futuro/vencido y su cancelación simulada, hecho con vigencia futura sin inferir plan, cambio sintético de domicilio/empleo con períodos compatibles, valores actuales en conflicto, referencias `asOf` incompatibles, fechas desconocidas, distinción de tiempo de fuente/recepción/registro, orden del historial, IDs duplicados, rechazo de subjects mezclados, conjuntos separados, vínculos evidence/source, intervalos inválidos y ausencia de mutación/autorización.

Las pruebas de sujetos y conjuntos separados demuestran únicamente que estas funciones puras no fusionan entradas entre llamadas. No son pruebas del aislamiento de almacenamiento ni de controles de acceso private/shared. Se usan fixtures en memoria; no se abre ningún repo ni store personal.

## Validación de D.1

Tras la auditoría final: D.1, 17/17; Automatic Memory, 209/209; Memory, 457/457; suite completa, 679/679. También pasó la sintaxis JavaScript y `git diff --check`. Los tests usan fixtures sintéticas y repositorios temporales donde ya lo requiere la suite. No hubo llamadas a OpenAI ni escrituras personales. No se modifican dependencias, Schema v5, backend ni integración runtime. Memory1 conserva el SHA-256 esperado; backend efectivo `memory1`; Memory2 y Automatic Memory siguen inactivas.
