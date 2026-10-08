# Automatic Memory B.2b.5 — Schema v5 y migración controlada

Esta etapa añade soporte estructural para Schema v5 y una migración explícita v4→v5. No añade el ejecutor B.2b.6, escritura automática de recuerdos, autorización automática ni integración con el agente. Las pruebas usan fixtures y directorios temporales.

## Schema y compatibilidad

Schema v5 agrega solamente `automatic_operations`, separado de `migrations`. Conserva las colecciones v4 y todas sus validaciones. `validateMemoryStore` selecciona el conjunto exacto de campos según `schema_version`: tanto v4 como v5 se pueden abrir; un v4 existente no se reescribe ni se actualiza al abrirlo. La versión actual usada para inicializar un store nuevo de Memory2 es v5, pero la selección del backend sigue separada y el backend predeterminado del producto continúa siendo Memory1.

Cada recibo contiene `operation_key`, `operation_fingerprint_sha256`, `operation_kind`, `status`, `authorization_request_id`, `expected_revision`, `expected_digest`, `result_revision`, `result_assertion_id`, `target_assertion_id`, `result_code` y `recorded_at`. La clave y el fingerprint son digests SHA-256 con formato estricto; ambas claves y los fingerprints deben ser únicos. El request ID tiene formato opaco `req_<uuid>` y no es una capacidad. El schema rechaza campos no declarados, por lo que no admite texto fuente, secretos, tokens/capacidades, claims de modelo ni propiedades adicionales.

Los estados válidos son `applied` y `rejected_terminal`. Un resultado aplicado debe apuntar a una assertion existente; ADD no puede superseder un destino y REPLACE debe apuntar a la assertion exacta supersedida. Un rechazo terminal no lleva assertion resultante y solo permite códigos de resultado enumerados. El resultado debe corresponder a `expected_revision + 1` y no puede apuntar a una revisión futura del store. La unicidad del fingerprint bloquea duplicados semánticos registrados.

El repositorio admite añadir recibos a un store v5, pero los trata como append-only: no permite reemplazar una clave existente ni borrar recibos. Un store v4 rechaza cambios a `automatic_operations`. Esto es soporte de almacenamiento y validación, no un writer de Automatic Memory.

La validación de schema no puede recomputar el fingerprint sin la operación fuente —que deliberadamente no se duplica en el recibo— ni demostrar que una autorización fue auténtica. Comprueba formato, unicidad, referencias y coherencia estructural. Clave/fingerprint siguen siendo metadatos, nunca autorización. Las garantías de idempotencia de una operación ejecutada requieren el futuro ejecutor transaccional y una decisión de autorización separada.

## Migración explícita v4→v5

`planMemorySchemaV4ToV5` ofrece una transformación pura y validada para fixtures y revisión offline. `migrateMemoryStoreV4ToV5` solo opera sobre el `storePath` absoluto que recibe; no tiene ruta por defecto, hook de startup ni acceso a Memory1. La migración:

1. Adquiere un lock exclusivo junto al archivo y valida el store fuente completo como v4.
2. Crea un temporal de backup con nombre aleatorio y apertura exclusiva, copia y sincroniza los bytes v4 y comprueba su SHA-256. Publica `.v4.bak` mediante un enlace duro exclusivo que falla si el nombre final ya existe; verifica que el destino publicado identifica el mismo archivo y conserva el digest. Nunca reemplaza un backup preexistente.
3. Copia todas las colecciones, IDs, Self, assertions, relaciones, historial temporal, fuentes, evidencia, provenance y recibos de migración sin reinterpretarlos; agrega `automatic_operations: []`, sube la versión, incrementa la revisión una vez y actualiza `updated_at`.
4. Valida el candidato v5, lo escribe y sincroniza en un temporal exclusivo del mismo directorio, vuelve a comprobar lock y digest fuente, y hace un único rename.
5. Relee y valida el resultado antes de responder. Si una repetición encuentra v5 válido, responde `already_v5` sin cambiar bytes ni revisión.

Un fallo mientras se prepara o verifica el temporal conserva v4 y elimina únicamente los nombres que todavía identifican el archivo temporal creado por ese intento. Si esa limpieza falla, la operación informa `memory_schema_migration_backup_cleanup_failed`, conserva el error original como `cause`, expone `residuePath` para intervención manual y deja intacto v4. Un backup `.v4.bak` preexistente nunca se elimina ni sobrescribe. Una vez publicado y verificado, el backup queda completo y se conserva aunque falle una etapa posterior, incluido el reemplazo del store; un reintento posterior verá el backup y se detendrá para evitar reemplazarlo. Si el resultado del rename es incierto, no se restaura ni se reintenta automáticamente: se inspeccionan el destino y el backup bajo lock. El backup exacto permite recuperación o rollback offline antes de que v5 acepte escrituras. No se debe restaurar v4 tras cambios v5, porque perdería esos cambios.

La sincronización del archivo antes de publicarlo y el rename del store reducen riesgos de interrupción, pero no prometen durabilidad universal: no se sincroniza de forma portable el directorio padre y las garantías dependen del filesystem, del sistema operativo y de que los demás escritores respeten el lock. Esta migración no se ejecutó contra datos personales.

## Límites y validación

No se implementaron ADD/REPLACE, el protocolo transaccional de recibos con cambios de memoria, una autorización ejecutable, reconciliación de writes inciertos ni compactación de recibos. No se afirma durabilidad universal; siguen aplicando las limitaciones de lock, filesystem y rename descritas en B.2b.4.

La suite cubre validación v5, duplicados e inconsistencias, append-only, lectura compatible de v4, transformación con historial/provenance, backup exacto, repetición idempotente, corrupción y fallo simulado antes del rename. Todas las migraciones de prueba trabajan dentro de directorios temporales.
