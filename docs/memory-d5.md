# Memory D.5 — Olvido, privacidad y correcciones

## Alcance

D.5 añade `evaluatePrivacyOperation()`, una evaluación determinista y sin efectos secundarios para cinco solicitudes: `correct`, `restrict`, `forget`, `delete` y `revoke_consent`. Solo consume fixtures sintéticas ya filtradas para una partición. No está conectada a `MemoryService`, repositorios, agente, CLI, Automatic Memory ni writers. No cambia Schema v5 ni elimina, modifica o persiste registros.

El contrato de entrada transporta una partición declarada, una identidad marcada `fixtureOnly`, una lista acotada de assertions con evidencia y fuentes, y una solicitud exacta. Las etiquetas de partición, IDs, rol Owner y fixtures no prueban identidad, propiedad, consentimiento ni autorización. Un conjunto mezclado o inconsistente se rechaza. Un preview válido para evaluación sigue requiriendo identidad confiable, autorización específica, revisión actual y confirmación; todos los resultados son `executable: false` y `persistencePerformed: false`. El modo `execute` siempre devuelve `DENY`.

## Significado de las operaciones

- **`correct`** propone revisar una assertion objetivo concreta junto con una nueva assertion candidata. Deben coincidir sujeto, tipo, predicado y slot de compatibilidad. D.1 describe ambas vigencias y D.3 compara el par. Un intervalo no solapado se clasifica como `temporal_change`, no como error demostrado. En los demás casos el resultado es `correction_unresolved`: no se elige qué fuente dice la verdad, no se altera evidencia y se requiere confirmación específica del target. La corrección de relaciones queda fuera de esta etapa.
- **`restrict`** proyecta restricciones explícitas por dimensión: recuperación, contexto, aprendizaje o compartición. No presume qué consumidores, índices o procesos existen; exige inventario autoritativo antes de un cambio real.
- **`forget`** propone excluir el recuerdo de recuperación y del contexto futuro. No significa borrado físico ni bloquea por sí solo el aprendizaje posterior; esas restricciones deben solicitarse explícitamente o resolverse mediante una revocación de consentimiento pertinente.
- **`delete`** se deniega como operación no soportada. El preview identifica dependencias visibles y declara como no verificables backups, logs, proveedores, índices derivados, proyecciones compartidas y referencias fuera del conjunto recibido. No afirma eliminación completa.
- **`revoke_consent`** modela una revocación para un propósito concreto (`analysis`, `learning`, `storage` o `sharing`). Filtra únicamente operaciones con el mismo `consentId` y estado `pending` dentro del snapshot sintético suministrado; excluye operaciones aplicadas, rechazadas, vencidas y asociadas a otro consentimiento. La revisión del snapshot se expone, pero su frescura no puede comprobarse aquí. El estado declarado del consentimiento y la identidad son datos de fixture, no prueba real; el resultado solo solicita revisión (`ASK`). No consulta ni modifica el almacén real de consentimiento ni invalida trabajos.

Las salidas `ASK` son solicitudes de confirmación y autorización futuras, no consentimientos concedidos. La revocación requiere identidad del titular y debe prevalecer sobre operaciones pendientes. El consentimiento para analizar, aprender, guardar o compartir permanece separado; una autorización anterior no se trata como permanente.

## Identidad y privacidad

La capa mantiene separados el rol administrativo declarado, el principal de la fixture, el sujeto de la assertion, el propietario de la partición y los destinatarios declarados. En una partición privada, un principal distinto del propietario se deniega incluso si su rol declarado es `Owner`. En una partición compartida, la membresía declarada tampoco concede permiso; las modificaciones por un destinatario distinto del propietario se deniegan y las demás requieren revisión explícita de destinatarios. Schema v5 no identifica de forma autenticada al autor humano de cada fuente; el tipo y la confianza de `source` son metadatos de procedencia, no identidad del aportante. Esto solo detecta inconsistencias de los datos recibidos: no constituye aislamiento real ni autorización.

`scopeLabel` es una etiqueta, no una credencial. La carga debe ser autenticada, autorizada y filtrada por una capa confiable antes de llamar a D.5. No se deben pasar memorias privadas ajenas para que la capa las filtre. Los IDs de assertions, evidencia, fuentes y dependencias se devuelven únicamente para el conjunto suministrado; no se devuelven valores, nombres, texto de evidencia ni contenido sensible.

## Referencias y límites de inventario

La proyección de dependencias inspecciona el conjunto recibido: la assertion objetivo, referencias `supersedes`, `derivedFromAssertionIds`, evidencia y fuentes de la assertion y dependientes detectados. Las referencias a IDs ausentes se muestran como `unverifiedReferenceIds`, nunca como historial inspeccionado. Su completitud es siempre `provided_partition_snapshot_only`. No demuestra que se hayan inspeccionado todas las referencias, consumidores, propuestas pendientes, backups o derivados externos. No elige una fuente ganadora ni adjudica la verdad de un hecho. Para evitar presentar IDs arbitrarios como trabajos revocables, `revoke_consent` consume un snapshot separado con revisión, estado y `consentId` por operación; aun así, el snapshot es hipotético y no autoritativo.

Memory1 ya tiene un `MemoryService.forget()` autorizado que elimina assertions seleccionadas, su evidencia, fuentes que quedan huérfanas y enlaces `supersedes` afectados. Esa ruta es una operación real distinta y no se invoca aquí; tampoco garantiza borrar copias en backups, logs o proveedores externos. D.5 no cambia esa operación ni la expone a las fixtures. Memory2 Schema v5 no recibe cambios por esta etapa.

## Pruebas

`test/memory-privacy-semantics.test.js` usa exclusivamente fixtures sintéticas. Comprueba la diferencia entre corrección, cambio temporal y plan/hecho, olvido y eliminación, restricciones por dimensión, revocación por propósito y operaciones pendientes asociadas al consentimiento, dependencias parciales y referencias externas no verificadas, rechazo de acceso Owner a particiones privadas ajenas, restricciones de ámbito compartido, inconsistencias de sujetos/particiones/referencias, identidad no autenticada, redacción, determinismo, ausencia de mutación y denegación de ejecución.

Las pruebas validan una proyección pura. No prueban autenticación, autorización real, revocación durable, aislamiento de almacenamiento, inventario completo de derivados, borrado físico ni transacciones. Una integración futura requeriría identidad y autorización verificadas, snapshot autoritativo con control de revisión, inventario completo de dependencias y consumidores, consumo atómico de confirmaciones y garantías de recuperación específicas del almacenamiento.
