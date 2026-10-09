# M.1d.1 — almacén local sintético y bootstrap Owner

## Alcance y separación

`src/core/identity-store.js` implementa un almacén explícito de snapshots JSON con transiciones acotadas de bootstrap. No hace I/O al importarse, exige una ruta absoluta y no se importa desde `src/index.js`, el agente, las tools ni la CLI. El módulo no autentica personas, no emite sesiones, no crea grants, no vincula Self y su evaluación de ejecución siempre devuelve `DENY`.

El formato de esta etapa está limitado intencionalmente al dominio `test.synthetic`: instalación, principal, ceremonia y referencias deben tener prefijo `test_`, y cada registro de credencial declara `test.synthetic_webauthn`. No es un registro válido de identidades de producción. `completeSyntheticBootstrap()` solo valida la forma del fixture y registra ese dominio sintético; por sí solo no autentica evidencia. La ruta de prueba completa usa el coordinador M.1c para verificar la assertion antes de llamar al almacenamiento. El coordinador vive solo en `test/support/owner-bootstrap-harness.js`; no se importa desde código productivo. Los tests crean archivos exclusivamente dentro de directorios temporales y los eliminan al terminar.

El harness M.1c genera claves EC sintéticas en memoria y valida sus ceremonias simuladas. Ese resultado demuestra únicamente que el fixture produjo una assertion coherente con su propio desafío. No demuestra una autenticación WebAuthn, Windows Hello, presencia humana ni identidad Jorge. El almacén solo recibe fingerprints de claves públicas y referencias sintéticas; no persiste claves públicas PEM, claves privadas, challenges en claro, firmas, secretos ni respuestas de ceremonia. La huella del challenge se conserva únicamente mientras el bootstrap está pendiente para vincular la evidencia sintética con la operación.

## Almacenamiento y transacción

Se eligió un solo archivo JSON de identidad independiente de Memory1 y Memory2. La implementación reutiliza el patrón local ya probado por `json-repository.js`: un lock sidecar exclusivo creado con `open(..., 'wx')`, un token aleatorio de propietario, escrituras serializadas dentro del proceso, comparación de revisión y digest bajo el lock, staging en un archivo exclusivo del mismo directorio, `sync()`, validación del staging y publicación mediante `rename()`.

La inicialización usa un temporal propio y `link()` como publicación atómica de creación si el destino aún no existe; nunca reemplaza un store preexistente. La limpieza de temporales comprueba el índice de archivo de Windows (o inode en sistemas compatibles) y solo elimina el archivo creado por esa operación. Si el lock preexiste, no se roba automáticamente. Un lock residual requiere inspección y recuperación offline explícitas.

Se evaluó `node:sqlite`, disponible en el Node 22.14 del entorno, pero el runtime lo anuncia como experimental. Como este batch no permite añadir dependencias, se eligió el mecanismo JSON de un solo archivo y el protocolo cooperativo ya existente. Los tests multiproceso cubren la serialización entre procesos que respetan el lock.

Una mutación publica el snapshot completo en una sola sustitución del archivo. Antes del rename, un fallo deja vigente el snapshot anterior; tras un fallo de respuesta, se relee el archivo para distinguir el digest anterior del nuevo. Si el archivo desaparece después de intentar publicar, el resultado se informa como incierto. Un resultado publicado se vuelve a reconocer al reabrir, y la revisión/digest antiguos no pueden repetirlo. El lock abarca tanto la lectura de la versión vigente como la comprobación CAS y la publicación.

El SHA-256 es un comparador de bytes para CAS y reconciliación, no un MAC ni una prueba de autenticidad: quien pueda modificar el archivo puede reconstruir un digest. La lectura valida el esquema además del digest esperado. Se rechazan rutas cuyo directorio final sea un symlink/junction y stores cuyo archivo sea un symlink; esto evita redirecciones simples, pero no verifica ACL/propietario del directorio ni impide que un escritor local no cooperativo sustituya archivos entre comprobaciones. El store debe vivir en un directorio privado y confiable. La protección ante manipulación local requiere una frontera del sistema operativo que este prototipo no implementa.

Estas garantías son de atomicidad lógica y concurrencia cooperativa en un filesystem local compatible. No prometen durabilidad ante pérdida eléctrica, comportamiento idéntico en todos los filesystems, protección contra escritores externos que ignoren el lock, ni resistencia a manipulación local del archivo o restauración de backups antiguos. El rename de reemplazo y el `sync()` no constituyen una garantía universal de persistencia física. Un corte abrupto que deje un lock puede requerir intervención manual; un archivo corrupto se rechaza sin repararlo.

## Estado y esquema

El snapshot contiene versión de esquema, `trustDomain`, `installationId`, estado de bootstrap, slot único `ownerPrincipalId`, referencias a credenciales públicas sintéticas, registros de credenciales, ceremonia pendiente, revisión monotónica, época de revocación, metadatos de recuperación y fecha de actualización. No incluye `memoryPersonId` ni redefine Self.

| Estado | Significado en este prototipo | Transiciones aceptadas |
| --- | --- | --- |
| `uninitialized` | Store sintético inicial sin Owner | `pending` |
| `pending` | Ceremonia de bootstrap sintética con expiración | `active`, `recovery_required` |
| `active` | Un único Owner **sintético**, con dos referencias de credencial distintas | `locked` |
| `recovery_required` | Bootstrap incompleto/expirado; no conserva un Owner utilizable | `pending`, `locked` |
| `locked` | Estado terminal del prototipo; ejecución siempre denegada | ninguna |

El bootstrap activo exige dos credenciales sintéticas distintas para el mismo principal e instalación. La política registra que un segundo autenticador es requerido y que una clave de recuperación offline es requerida, pero `offlineRecoveryKeyStatus` permanece `not_generated`; no se genera ni guarda una clave. Este Owner sintético no puede iniciar recuperación real. No hay transferencia de Owner ni camino para crear un segundo.

Las entradas tienen forma estricta y los campos extra se rechazan. Revisión y digest deben coincidir con el snapshot actual; una ceremonia expirada, una transición desde estado incompatible, un segundo bootstrap o un replay no publican cambios. Una expiración debe pasar explícitamente a `recovery_required` y comenzar otra ceremonia con challenge nuevo. Claims como `verified`, texto del modelo, SID, voz, presencia de Windows Hello o una fixture genérica no forman parte de la autoridad de almacenamiento.

## Recuperación e incertidumbre

- **Fallo antes de publicar:** se conserva el snapshot anterior. Si la ceremonia M.1c ya fue verificada/consumida, no se reutiliza: el intento pendiente se deja expirar, pasa a `recovery_required` y se inicia uno nuevo.
- **Fallo al publicar:** el código compara el digest observado. Si sigue vigente el anterior, rechaza; si aparece el nuevo, devuelve el estado reconciliado; si no puede determinarlo, informa un resultado incierto y requiere reabrir e inspeccionar.
- **Respuesta perdida después del commit:** reabrir y leer revisión, estado y digest. Si ya está activo, no volver a ejecutar la mutación. Una solicitud con snapshot anterior falla por conflicto.
- **Store corrupto o lock existente:** fallar cerrado, preservar bytes/lock y requerir recuperación offline. No hay reparación automática ni eliminación de locks.
- **Backup/rollback:** restaurar una copia antigua puede revertir revisión y estado. Esta fase no tiene ancla antirrollback fuera del archivo; los backups deben protegerse y una restauración futura requerirá protocolo explícito.

La excepción puede señalar un temporal residual mediante `temporaryResidue`, `cleanupCode` y `residuePath`. El proceso solo intenta borrar temporales cuya identidad de archivo coincide con la que abrió. Si no puede comprobarla, conserva el archivo y reporta el residuo.

## Pruebas y límites

Las pruebas de `test/memory-m1d1-owner-store.test.js` usan repositorios temporales reales y procesos hijos independientes para carreras de inicialización/bootstrap, muerte mientras se posee el lock, CAS, reapertura, replay, expiración, store estructuralmente inválido aunque se regenere su digest, rutas con symlink/junction, escritura parcial, fallo de rename antes y después de publicar, fallo de limpieza y salida del proceso tras publicar pero antes de responder. El coordinador sintético importa y reutiliza `test/support/webauthn-harness.js`; verifica user presence/verification y firma antes de preparar el snapshot activo. Los tests de M.1c siguen siendo tests de protocolo simulado, no de autenticación criptográfica WebAuthn real.

Validación de esta revisión: M.1d.1 **22 aprobadas y 1 omitida por el privilegio de symlink de archivo no disponible en Windows**; M.1c **18/18**. La prueba real de junction/directorio sí se ejecuta y pasa. La suite completa se ejecuta con acceso limitado a directorios temporales sintéticos; el primer intento sin elevación encontró `EPERM` al crear fixtures, y la repetición autorizada pasó. También se validaron sintaxis JavaScript, whitespace y `git diff --check`. El primer ciclo de desarrollo detectó que Node autodetectaba el worker auxiliar como test; se movió a `test-support/`.

No se ha creado un bootstrap real. No existen sesiones, dispositivos vinculados, permisos, acceso a memoria, recuperación Owner, interfaz de confirmación nativa, autenticación humana ni una frontera de autorización productiva. El almacenamiento no se conecta al agente ni a las tools. `active` solo describe el estado del fixture. Un futuro verificador de producción debe rechazar el dominio `test.synthetic`, los IDs `test_` y `evidenceKind: test.synthetic_webauthn`; el API sintético no puede reutilizarse como verificador.

Antes de cualquier uso real se requieren proveedor nativo verificado, bootstrap Owner fuera del modelo, política aprobada de segundo autenticador y recuperación offline, protección del archivo y backups, revisión específica de amenazas, control de rollback, recuperación de locks y pruebas en cada filesystem soportado. Windows Hello permanece fallando cerrado. El Owner de C.5g sigue separado de Self y de las particiones privadas.

Este batch no modifica `data/memory.json`, no abre ni crea `data/memory-v2.json`, no cambia el backend efectivo `memory1`, no activa Automatic Memory y no realiza llamadas a OpenAI. No añade dependencias.
