# Automatic Memory B.2b.8a — Frontera de escritura autorizada

## Alcance y estado inspeccionado

Este documento diseña una frontera de persistencia; no añade código ni habilita escrituras. La inspección parte del commit `7d24ab457e85d7461b3d23c732c406ac5dd4733b`. Memory2 sigue separada del backend efectivo Memory1.

El repositorio JSON es un almacén de bajo nivel. `createJsonMemoryRepository()` devuelve `open`, `readSnapshot`, `commit` y `close`. `commit()` valida el lote, revisión y digest, serializa llamadas de la instancia, coordina con el lock, construye el store completo, valida referencias y lo publica con un reemplazo de archivo. Sin embargo, el repositorio no verifica autorizaciones de dominio. Sus cambios tipados pueden añadir, reemplazar o borrar assertions, sources y evidence; también pueden añadir recibos v5 `automatic_operations`. El schema comprueba forma, unicidad, enlaces y consistencia, no quién autorizó los bytes.

## Mapa actual de escrituras

| Ruta | Llamadores y datos que escribe | Control existente y límite |
| --- | --- | --- |
| Primitiva del repositorio | `repository.commit({ expectedRevision, expectedDigest, changes })`; acepta puts/deletes de colecciones permitidas y pone recibos automáticos v5. | CAS lógico por revisión/digest, lock cooperante y validación estructural. No consume autorización de MemoryService ni del coordinador; un caller con la instancia puede construir un lote válido. |
| MemoryService | `remember`, `forget`, operaciones de persona/nombre y creación/corrección/borrado de relaciones terminan en `repository.commit()`. | Las rutas del servicio consumen antes un grant explícito y de un solo uso de `authorization.js`, ligado a un comando actual de stdin y a la propuesta/target. La confianza vive en el servicio; el repositorio no revalida ese grant. `remember` puede superseder por slot y no es la semántica append-only de Automatic Memory. |
| Migración Memory1→Memory2 | `applyMemory1Migration()` construye assertions, source, evidence y recibo `migrations`, y llama `repository.commit()`. | Invocación explícita, destino vacío y recibo de migración. Es una ruta distinta; no debe recibir permisos automáticos ni confundirse con `automatic_operations`. |
| Tests y simuladores de Automatic Memory | `memory-automatic-write-operations.test.js` usa un writer y permisos sintéticos dentro del test; `memory-automatic-idempotency.test.js` usa su propio ledger/simulador y prueba aparte el lock real. | No son rutas de producción ni demuestran que `repository.commit()` consuma la capability real. |
| Coordinador B.2b.7 | Prepara y confirma ADD/REPLACE; su capability puede ser consumida por `consumeAutomaticMemoryAuthorization()`. | Capability opaca en WeakMap, un uso, ligada a operación, fingerprint, snapshot, destinatario y turno. No existe consumidor de escritura; B.2b.1 continúa denegando y el resultado declara `executable: false`, `writeReady: false`. |

Los callers productivos de `repository.commit()` encontrados son MemoryService y el migrador explícito. Los demás matches están en tests/fixtures. El agente y tools no importan el coordinador ni un ejecutor. Aun así, la API de bajo nivel no es por sí misma una frontera de autorización.

## Fronteras de confianza

- La salida del detector, los IDs, provenance, intención y predicados propuestos son datos no confiables. B.2a vuelve a validar candidatos y policy, pero permanece dry-run.
- B.2b.1 compara claims ordinarios y siempre deniega; no es el issuer de Automatic Memory.
- B.2b.7 reconoce una capability auténtica por identidad privada y la consume en cada intento de verificación. Una cadena, request ID, booleano, objeto con campos similares o `source: automatic` no es prueba.
- La sesión `local_runtime_session` demuestra entrada local observada por el proceso, no identidad humana autenticada.
- El repositorio comprueba consistencia de datos y exclusión entre escritores cooperantes; no conoce la semántica de la aprobación.
- MemoryService conserva su autorización manual actual. Un grant automático no debe sustituir ni fabricarse para operaciones manuales.

## Arquitectura recomendada: operación automática tipada dentro del repositorio

Recomiendo la alternativa **A, con una restricción indispensable**: la transacción automática debe ejecutarse dentro de la sección crítica del repositorio, pero el `commit()` genérico no debe permitir publicar recibos `automatic_operations`. El método nuevo no debe aceptar un lote libre de cambios ni considerar `authorization_request_id` como autoridad. Recibe una solicitud cerrada con datos para recomputar el plan y la capability opaca auténtica; revalida, construye los cambios internamente y los envía a la misma primitiva atómica.

La división de responsabilidades propuesta:

1. **Coordinador** mantiene el plan confirmado privado y emite la capability B.2b.7 solo después de la confirmación de `stdin`. Su operación, fingerprint, snapshot, destinatario, turno y target exactos deben coincidir con la solicitud de ejecución.
2. **Ejecutor interno** recibe texto original, propuesta no confiable, índice de operación, destinatario y capability. Normaliza de nuevo, aplica secret screening y policy vigente, recalcula la clave B.2a y fingerprint y confirma que el grant corresponde a ese plan. No acepta records construidos por el caller.
3. **Repositorio transaccional** adquiere/verifica el lock, relee el store y consulta los recibos dentro de esa sección crítica. Si no es un replay aplicado idéntico, consume la capability real mediante `consumeAutomaticMemoryAuthorization()` antes de aceptar cualquier ejecución. Después compara revisión/digest actuales con el snapshot autorizado y vuelve a validar la operación contra el store actual. El consumo no se devuelve ante ningún error.
4. **Constructor de cambios confiable** asigna IDs y timestamps, fija provenance como `inference`/`derived_untrusted` y `data_only`, genera evidencia sin guardar el texto citado innecesariamente y forma el recibo. El caller no elige el source, el assertion final, el estado ni el recibo.
5. **Commit único** aplica la assertion, evidence, source y recibo en un candidato validado y una única revisión. En REPLACE, el mismo candidato marca `superseded` solo el target exacto y añade la nueva assertion con `supersedes: [target]`; historial y evidencia anterior permanecen. En ADD no se modifica ni supersede ninguna assertion previa.

`repository.commit()` sigue disponible para los flujos manuales y de migración existentes, que ya tienen sus controles de dominio en MemoryService o en la operación explícita de migración. La API genérica debe rechazar puts/deletes de `automatic_operations` para que no se pueda registrar un supuesto resultado automático aportando solamente campos de receipt. El método automático usa internamente la misma construcción/validación de candidatos, no un `skipAuthorization` o un marcador de procedencia.

**Límite que debe quedar explícito:** como `commit()` es una primitiva genérica que acepta assertions/source/evidence válidos, no puede inferir si un lote arbitrario representa una decisión de Automatic Memory. No existe un `source` fiable que permita distinguirlo. Por ello, B.2b.8b debe también mantener la referencia de `repository.commit()` fuera del agente, tools y cualquier consumidor de propuestas, y definir esos callers como código de confianza. Si se exige proteger también frente a cualquier módulo interno que pueda invocar la primitiva, la alternativa C (puertos de escritura separados y primitiva cruda privada) es necesaria antes de conectar Automatic Memory al runtime. No se debe afirmar protección frente a código arbitrario dentro del mismo proceso ni frente a escritores que ignoran el lock.

### Comparación

| Alternativa | Ventajas | Riesgos y evaluación |
| --- | --- | --- |
| **A. Método transaccional autorizado en el repositorio** | Comprueba receipt, freshness, capability y cambios en el mismo lock; comparte la publicación atómica actual; mínima duplicación de locking/rename. | Segura solo si el método construye cambios, consume la capability real y el commit genérico no puede escribir recibos automáticos. No identifica un assertion arbitrario sin receipt como “automático”; el grafo de imports sigue siendo parte del límite. **Recomendada para B.2b.8b bajo este límite operativo.** |
| **B. Adaptador que envuelve `commit()`** | Separa el armado del plan y los cambios del API de storage; fácil de probar como componente. | Si el adaptador solo hace `readSnapshot()` seguido de `commit()`, el lookup del receipt y el freshness check quedan fuera de la sección crítica. Si cualquier caller conserva el repositorio crudo, puede evitar el adaptador. Solo sirve si el repositorio ofrece una transacción cerrada/privada que el adaptador no pueda sustituir con cambios arbitrarios. |
| **C. Puertos separados para manual, migración y automático** | Hace visibles las capacidades de cada dominio; evita pasar la primitiva genérica al ejecutor o al agente; mejor frontera si crecen los escritores. | Refactoriza interfaces y todos los callers/tests. Requiere conservar autorización manual y flujo explícito de migración sin darles grants automáticos. Un puerto que exponga el mismo `commit(changes)` genérico solo renombra el bypass. **Preferible antes de integración con agente o si se requiere aislamiento fuerte entre módulos.** |

## Reglas de transacción

### Recibos, snapshot y capability

- Bajo lock, buscar primero por `operation_key` y por fingerprint. Un recibo `applied` solo se reconoce como replay si key, fingerprint y tipo coinciden; devolver el resultado conocido no modifica el store ni consume/reutiliza una capability. Misma key con fingerprint diferente, o mismo fingerprint con otra key, falla cerrado.
- Si no hay recibo aplicado exacto, la capability auténtica se consume en el primer intento de ejecución, incluso si el snapshot está obsoleto o los bindings no coinciden. El coordinador la quema ante destinatario, operación, fingerprint, revisión/digest o target alterados. No consumir con un claim reconstituido.
- Comparar el snapshot semántico autorizado y su revisión con el store leído bajo lock; usar también el digest de bytes/revisión que el repositorio necesita para detectar alteraciones externas. No rebasear ni regenerar un plan después de la confirmación.
- Un conflicto, rechazo de policy o fallo anterior al reemplazo consume la capability y no escribe recibo de operación aplicada. Para intentar de nuevo, hace falta volver a leer, planificar y confirmar una nueva operación/capability.
- La serialización del repositorio evita que dos llamadas de la misma instancia consuman a la vez; el lock evita que dos repositorios cooperantes hagan commit simultáneo. La capability de WeakMap no puede reconstruirse tras reinicio. No se promete exactly-once ante cualquier fallo físico.

### ADD

Solo se admite un candidato elegible, no sensible, no duplicado, con Self resuelto estructuralmente y provenance inferida explícitamente. El ejecutor añade una nueva assertion y sus source/evidence. No cambia recuerdos previos aunque coincidan en predicate/slot. Si el snapshot actual revela duplicado, conflicto, cambio de policy o falta de evidencia, se cancela sin mutación y se requiere nueva evaluación; no se cambia silenciosamente a REPLACE.

### REPLACE

Requiere la operación REPLACE aprobada por B.2b.7 y un target único del snapshot. Bajo lock se comprueba que el ID exacto sigue activo y que sujeto, predicate, valor anterior, valor nuevo y operation fingerprint son los mismos que vio y confirmó el usuario. La confirmación debe incluir el ID del target exacto. Si algo cambió, no elegir otro target ni modificar la operación: consumir el grant, devolver conflicto y solicitar nueva planificación/confirmación. El commit conserva el assertion superseded, su evidence y su provenance.

## Fallos, replay y resultado incierto

| Momento | Resultado exigido |
| --- | --- |
| Receipt aplicado exacto ya existe | Respuesta idempotente de solo lectura; no nueva escritura. La clave/fingerprint no constituyen autoridad para otra operación. |
| Sin receipt; capability ausente, falsificada, usada o con binding distinto | Rechazo, cero cambios y cero receipt. Los claims `authorization_request_id`, `granted` o `source` no sustituyen el proof. |
| Capability consumida; snapshot obsoleto, target cambiado, policy inválida o fallo antes de rename | Cero cambios; no restaurar la capability. Si se comprueba que el store previo sigue íntegro y no hay receipt, reportar `not_applied`; una nueva ejecución necesita una autorización nueva. |
| Error durante/después del rename | No afirmar éxito o fallo por la excepción sola. Reabrir el repositorio bajo lock; si assertion+evidence+source+receipt aparecen coherentes en la misma revisión, reconocer `applied`. Si se demuestra estado previo intacto y sin receipt, `not_applied`. Si no se puede probar ninguno, `unknown`, bloquear escrituras y requerir intervención. |
| Reinicio después del commit y antes de responder | Capability desaparece; un nuevo intento puede consultar el receipt exacto y reportar el resultado sin escribir. No reutilizar autorización ni reproducir la operación si el receipt no permite probar el commit. |
| Dos operaciones concurrentes | Solo una puede confirmar contra el snapshot esperado. La otra consume su propia capability y falla por conflicto; debe volver a planificar y confirmar. Una misma capability no puede aprobar dos operaciones concurrentes. |

Los recibos `automatic_operations` aplicados deben ser append-only e inmutables. Borrarlos o reescribirlos permitiría repetir ADD o perder evidencia de un resultado incierto. El schema garantiza estructura, no autenticidad; la autenticidad y el vínculo con la mutación los garantiza únicamente el camino transaccional autorizado.

Atomicidad lógica (un snapshot/rename), concurrencia cooperativa (lock/revisión/digest) y durabilidad física (filesystem/OS) son garantías diferentes. Continúan aplicando los límites de B.2b.4/B.2b.5: un writer externo que ignore el lock no queda protegido y no se promete durabilidad universal.

## Riesgos y decisiones pendientes

- La sesión local de stdin no autentica identidad humana. La confirmación representa solo la acción observada en el canal local definido por B.2b.7.
- El coordinador actual devuelve una capability, pero B.2b.1 todavía declara denegación y `executable`/`writeReady` falsos. B.2b.8b debe revisar la compatibilidad de esos contratos sin hacer que claims ordinarios puedan levantarlos.
- El digest que usa el planificador debe adaptarse correctamente al snapshot del repositorio: el digest semántico de B.2a y el digest de bytes usado por CAS no son intercambiables. El ejecutor debe derivar ambos desde el snapshot leído, nunca aceptar uno del modelo como actual.
- Hay que decidir el resultado público mínimo del replay para no filtrar datos adicionales del store.
- Las capabilities no son durables. Tras un fallo precommit se exige nueva confirmación; tras resultado incierto se reconcilia, no se reintenta a ciegas.
- Tests previos B.2b.2/B.2b.3 son simuladores, no validación de un ejecutor real. Toda nueva garantía debe probarse contra `createJsonMemoryRepository()` en directorios temporales.
- Ninguna propuesta convierte a la sesión local en identidad autenticada ni habilita Memory2 personal. La futura integración al agente requiere una revisión independiente de accesibilidad, privacidad, límites de preview y superficie de módulos confiables.

## Plan incremental

### B.2b.8b — Frontera y transacción autorizada mínima

1. Definir la interfaz interna cerrada y la separación de puertos mínima. Auditar imports para que agente/tools no reciban repositorio, capability ni ejecutor.
2. Impedir que `repository.commit()` genérico escriba recibos `automatic_operations`; probar append-only y ausencia de sustitución/eliminación. No usar campos de provenance como control.
3. Añadir el método transaccional que, bajo el lock del repositorio, consulta idempotencia, consume la capability real del coordinador, compara snapshot actual, revalida el plan y construye cambios internamente.
4. Implementar solo ADD append-only y REPLACE de target exacto. Assertion, evidence, source/provenance y receipt en un único candidato validado y una sola revisión. Mantener B.2b.1 en denegación salvo que una revisión explícita determine un cambio de contrato estrictamente necesario.
5. Pruebas sintéticas mínimas en repositorios temporales para éxito, ausencia/falsificación/replay de capability, mismatch de bindings, snapshot obsoleto, duplicado, colisión, target incorrecto, historial y rutas desde agente/tools.

### B.2b.8c — Fallos, recuperación e idempotencia adversarial

1. Inyectar fallos antes de staging, durante sincronización, antes/después de rename y tras commit con respuesta perdida.
2. Probar reabrir y reconciliar receipt, estado previo y estado incierto; jamás repetir una operación sin receipt idéntico o nueva capability.
3. Probar dos instancias, doble consumo concurrente, misma key/fingerprint, key reutilizada con fingerprint distinto y conflicto de target/revisión.
4. Verificar corrupción, append-only, conservación de historial/provenance y que los tests identifiquen qué propiedades pertenecen al repositorio real frente a simulaciones.
5. Hacer release/security review separado antes de cualquier integración con agente, activación de Memory2 o migración personal.

Antes de habilitar ejecución deben existir: verificación real de capability (no claims), consumo único incluso ante fallos, freshness bajo lock, construcción confiable de registros, receipt y memoria en una revisión, recuperación que falle cerrada, pruebas contra repositorio real temporal y ausencia de ruta desde modelo/tools. Esta propuesta no afirma que dichas garantías estén implementadas hoy.
