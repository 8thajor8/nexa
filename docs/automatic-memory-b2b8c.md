# Automatic Memory B.2b.8c — Pruebas adversariales y recuperación

## Alcance

Esta fase somete `createJsonMemoryRepository().commitAutomaticOperation()` a fallos, reintentos y carreras usando archivos v5 sintéticos en directorios temporales. No cambia código de producción, no ejecuta llamadas de red y no conecta el escritor al agente o a tools. Las inyecciones de fallos sustituyen operaciones puntuales del adaptador de filesystem; los repositorios, locks, archivos, validación del schema, publicación por rename, recibos y reconciliación probados son los de producción.

Las pruebas históricas de B.2b.2 y B.2b.3 incluyen escritores/ledgers simulados. Sus resultados no se usan aquí como evidencia de las propiedades del repositorio real. La exclusión de un segundo proceso cooperante sobre el mismo archivo está comprobada además por el test real de lock en `memory-automatic-idempotency.test.js`.

## Escenarios ejecutados contra el repositorio real

`test/memory-automatic-transaction.test.js` usa procesos hijos para obtener turnos y confirmaciones sintéticas desde stdin confiable, repositorios JSON v5 temporales y, para fallos de persistencia, el filesystem inyectable de `json-repository.js`.

| Escenario | Resultado observado |
| --- | --- |
| ADD autorizado y REPLACE autorizado | Cada operación publica assertion, source/provenance, evidence y recibo en revisión única. REPLACE supersede solo el target confirmado y conserva la assertion, evidence y provenance anteriores. |
| Replay exacto de ADD y REPLACE, incluso después de cerrar y reabrir | Devuelve `already_applied`; revisión, cantidad de assertions y recibos no aumentan. El recibo aplicado permite reconocer el resultado sin reutilizar la capability. |
| Mismo `operation_key` con fingerprint distinto | Tras aplicar una operación, la prueba altera offline el fingerprint persistido manteniendo un recibo estructuralmente válido. El siguiente intento se rechaza como `automatic_idempotency_conflict`; no escribe una nueva revisión. Esta es una prueba adversarial de colisión/inconsistencia, no un flujo de mutación soportado. |
| Fallo al escribir parcialmente el temporal | El repositorio devuelve `memory_persist_failed`; el archivo original permanece en revisión 0, no hay assertion ni recibo, el temporal propio se limpia y la capability queda consumida. |
| Fallo de sincronización del temporal | Igual: store original intacto, sin receipt, temporal limpiado y capability consumida. |
| Rename falla antes de publicar | La reconciliación lee el estado original y devuelve `memory_persist_failed`; no hay mutación y la capability no se puede volver a usar. |
| Rename publica y luego el adaptador informa error | El repositorio vuelve a leer el store, reconoce el digest candidato y devuelve `applied`. Reintentos en proceso y tras reapertura devuelven `already_applied`. |
| Rename publica pero falla la lectura de reconciliación | La llamada devuelve `memory_commit_uncertain` y la instancia bloquea nuevas operaciones. Tras cerrar y reabrir, el store v5 real contiene la revisión y receipt aplicados; el replay exacto devuelve `already_applied`. |
| Snapshot obsoleto | La operación se rechaza sin receipt ni mutación; la capability se consume. El intento posterior con esa capability se rechaza. |
| Fallo anterior a consumir capability | Repositorio cerrado o lock no verificable falla antes del verificador. Restaurado el estado temporal de prueba, el mismo plan/capability puede reintentarse y aplicarse. No se había empezado una transacción ni publicado datos. |
| ADD/ADD, ADD/REPLACE y REPLACE/REPLACE simultáneos sobre un snapshot | El lock en la instancia serializa los commits. Para operaciones diferentes, solo gana una; la otra recibe conflicto de revisión y no se replanifica. Dos confirmaciones de la misma operación convergen a un receipt y una revisión. |
| Dos intentos simultáneos con una capability | Solo una mutación; el segundo llega después del receipt y es un replay de solo lectura. |
| Store corrupto | `open()` rechaza el JSON corrupto y conserva sus bytes sin inicializarlo ni sobrescribirlo. |
| Recibos y colecciones | Siguen cubiertos el rechazo de `commit()` genérico para insertar/borrar recibos y la validación del schema de los enlaces a assertion/evidence/source. |

La prueba que simula pérdida de respuesta deja que el rename real complete y luego hace fallar la operación inyectada. La prueba de resultado incierto deja que el rename real complete, falla las lecturas de confirmación dentro de la llamada y luego reabre con filesystem normal. Esto prueba las ramas de reconciliación del repositorio, no un corte eléctrico ni todos los comportamientos posibles del sistema operativo.

## Resultado de la revisión

No se reprodujo un defecto que requiera cambiar autorización, transacción o schema. Las fallas prepublicación queman la autorización una vez consumida; un replay aplicado idéntico no consume autorización ni genera otra revisión; una misma clave con fingerprint distinto falla cerrada. La cola de la instancia y la revisión/digest CAS evitan escrituras perdidas en las carreras probadas.

El único estado en el que se permite repetir la misma capability es un fallo comprobado antes de entrar en el verificador (por ejemplo, repositorio cerrado o lock perdido). En ese punto no se leyó/publicó una operación y la capability sigue vigente; cuando el intento alcanza el verificador, se consume antes de validar binding, snapshot y persistencia. Si el snapshot quedó obsoleto o falla la preparación/publicación, hace falta volver a planificar desde el estado actual y obtener una autorización nueva.

## Procedimiento ante resultado incierto

Ante `memory_commit_uncertain`, no repetir a ciegas ni preparar una operación distinta. La instancia queda bloqueada. Cerrar y reabrir el repositorio bajo su lock cooperante, validar el store y buscar el receipt por clave/fingerprint, comprobando sus enlaces y la revisión:

- Si el receipt aplicado exacto y los records de la operación están presentes juntos, informar `already_applied` sin escribir.
- Si se verifica que el estado original sigue intacto y no existe receipt aplicado, planificar de nuevo y obtener una capability nueva antes de otro intento.
- Si el store no se puede validar, los records/receipt no concuerdan o el resultado no es demostrable, detener escrituras y requerir inspección manual. No reparar ni borrar receipts automáticamente.

## Garantías y límites

- **Atomicidad lógica:** las pruebas observan que assertion, source/provenance, evidence y receipt se publican juntos como una revisión mediante reemplazo del archivo. Los readers cooperantes no observan el candidato parcial.
- **Concurrencia cooperativa:** la cola serializa una instancia; el lock exclusivo y revisión/digest protegen frente a otras instancias/procesos que respeten el protocolo. El test de lock de proceso confirma que una segunda instancia no adquiere el mismo store mientras el propietario lo mantiene abierto.
- **Durabilidad física:** `sync()` del temporal y rename no prueban durabilidad universal frente a pérdida de energía, fallos de hardware, semánticas distintas del filesystem ni ausencia de sincronización del directorio. El lock no protege frente a editores externos que ignoren el protocolo.
- **Fallos simulados:** el adaptador inyectado produce condiciones deterministas, pero no modela todos los errores de kernel, terminación abrupta del proceso, corrupción de hardware ni fallos de almacenamiento remoto.
- **Exclusión de concurrencia:** no se afirma exactly-once universal. La idempotencia observada depende de que el receipt aplicado permanezca válido e íntegro en Schema v5.
- **Seguridad de producto:** la sesión local stdin no autentica a una persona. Automatic Memory permanece desconectada del agente y las tools; estas pruebas no activan Memory2 ni permiten persistencia automática de uso personal.

## Validación de esta etapa

Se ejecutaron 18 pruebas específicas de transacción, 94 pruebas de Automatic Memory, 288 pruebas de Memory y 481 pruebas de la suite completa; todas pasaron. La primera ejecución de la suite completa dentro del sandbox tuvo un fallo de entorno al iniciar Chromium (`spawn EPERM`) en una prueba de Voice Identity; al repetir la misma suite con permiso para crear ese proceso, pasó 481/481. `git diff --check` se ejecutó sin errores. No se modificaron dependencias, CRM, Memory1 ni stores personales; no hubo migraciones ni llamadas a OpenAI.
