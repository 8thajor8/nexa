# Memory M.1e.4 — Comparación experimental JSON y SQLite

## Alcance y aislamiento

Este experimento compara dos almacenamientos de snapshots sintéticos con el mismo formato de `test.synthetic` de M.1d.1. El baseline JSON reutiliza `createSyntheticLocalIdentityStore()` sin modificarlo. El segundo backend existe solo en `test/support/memory-persistence-comparison.js` y usa `node:sqlite`; no reemplaza `src/core/identity-store.js`, no se importa desde producción y nunca emite autorización ejecutable. El worker de procesos independientes está en `test-support/` para que el runner de Node no lo descubra como prueba.

Los stores se limitan a carpetas temporales cuyo nombre empieza por `nexa-m1e4-`. No se usan identidades reales, datos de Memory1/Memory2, credenciales ni llamadas de red. El snapshot conserva el esquema sintético de M.1d.1: instalación de test, estado de bootstrap, propietario opcional de test, referencias de credenciales sintéticas, revisión, época de revocación y recuperación pendiente. La única transición mutante en el harness es `lockStore`, que cambia el estado a `locked`, incrementa revisión y época. Toda decisión de ejecución devuelve `DENY`; no hay autenticación ni escritura de identidad productiva.

La comparación verifica que estados equivalentes tengan el mismo digest canónico, independientemente de que JSON lo almacene como archivo o SQLite como fila. Ambas rutas validan el snapshot con el validador M.1d.1 antes de aceptarlo.

## Implementaciones comparadas

| Área | JSON transaccional existente | SQLite experimental del harness |
|---|---|---|
| Escritura concurrente | Archivo `.lock` creado exclusivamente (`wx`), token e identidad del lock, CAS de revisión y digest; el escritor concurrente falla cerrado si el lock está ocupado. | `BEGIN IMMEDIATE`, timeout de espera, CAS dentro de la transacción y bloqueo del motor entre procesos. |
| Publicación | Escribe temporal exclusivo en el mismo directorio, sincroniza el archivo, vuelve a validar y publica mediante rename; relee el destino para reconciliar una respuesta perdida tras publicar. | Actualiza revisión, digest y cuerpo en una transacción SQLite; en el harness se usa WAL y `synchronous=FULL`. |
| Revisión obsoleta | Rechaza por revisión/digest bajo lock. | Rechaza por revisión/digest dentro de `BEGIN IMMEDIATE`. |
| Reapertura | Revalida estructura, revisión y digest del archivo. | Ejecuta `PRAGMA integrity_check`, valida estructura y compara revisión y digest de la fila. |
| Terminación del proceso | El archivo de snapshot anterior sigue siendo legible durante el staging; un lock residual no se roba y bloquea nuevos escritores hasta recuperación offline. | El lector ve el último commit; SQLite recupera la transacción no confirmada cuando termina el proceso y libera el lock del motor. |
| Archivos auxiliares observados | El archivo JSON; lock y temporal son transitorios durante escrituras. | La base y, mientras está abierta, `-wal` y `-shm`; su ciclo de vida y backups forman parte de la operación. |
| Integridad lógica | JSON válido más el esquema estricto y el digest recalculado. | `integrity_check` cubre estructura SQLite; además se necesitan el esquema estricto de la aplicación y el digest. |

La tabla refleja solo escenarios ejecutados en este harness. No significa que el protocolo JSON proteja de todo escritor que ignore su lock ni que SQLite sea una frontera de autorización.

## Experimentos y resultados

Las pruebas focalizadas ejecutadas en Windows 11 cubrieron:

- Inicialización sintética equivalente, revisión/digest comunes y denegación de cualquier solicitud de ejecución.
- Una transición con snapshot vigente, rechazo de repetición con revisión vieja y reapertura conservando el estado.
- Dos procesos independientes que escriben contra el mismo snapshot: se confirmó exactamente un ganador para cada backend; el otro recibió conflicto de revisión o lock ocupado.
- Lectura mientras hay una escritura pendiente: JSON mantuvo legible el snapshot anterior mientras un proceso poseía el lock y un temporal parcial; SQLite en WAL dejó leer el último estado confirmado mientras otro proceso tenía una transacción `BEGIN IMMEDIATE` con una fila no confirmada alterada.
- Terminación abrupta del escritor: el lock JSON quedó intacto y bloqueó el retry; al terminar un escritor SQLite con una transacción sin commit, la reapertura pasó `integrity_check` y mostró el snapshot anterior.
- Fallo antes de publicar: rename JSON inyectado falló antes de mover el temporal; SQLite recibió un fallo antes del commit. Ambos conservaron revisión 0.
- Respuesta perdida después de publicar: el rename JSON se realizó y luego devolvió error; el store JSON reconcilió el digest y devolvió el snapshot publicado. En SQLite se inyectó pérdida de respuesta después del commit; la llamada informó resultado incierto y una reapertura observó el estado confirmado.
- Permiso denegado, inyectado en el rename JSON y antes del commit SQLite, sin cambiar ACL del sistema; ambos conservaron el estado anterior.
- JSON malformado, cuerpo SQLite malformado o digest/revisión inconsistentes: ambas implementaciones rechazaron el estado.
- Restauración de una copia antigua y eliminación del store: ambas volvieron a aceptar el snapshot inicial anterior o recreado. Esto demuestra que revisión y digest locales no son anclas antirrollback.
- Directorio padre ausente: ambas rutas fallaron cerradas.
- Archivos auxiliares durante la conexión: JSON produjo `identity.json`; SQLite produjo `identity.sqlite`, `identity.sqlite-wal` e `identity.sqlite-shm` en la ejecución observada.

Los fallos de escritura, permisos y respuesta se inyectaron en puntos de control del harness; no son fallos físicos del disco. La terminación abrupta sí se hizo con procesos hijos reales. No se simuló corte eléctrico, corrupción física de páginas durante un flush, ni terminación dentro de cada instrucción del sistema de archivos. Los tests de fallo de cleanup del store JSON productivo y las pruebas de locks obsoletos de M.1d.1 siguen aportando cobertura complementaria; el harness SQLite no implementa borrado de residuo porque el motor administra WAL/SHM.

El directorio temporal estaba en un volumen **NTFS**, comprobado mediante la información de volumen de Windows. No se modificaron ACL persistentes ni privilegios globales.

El harness rechaza antes de abrir un store una raíz de fixture que resuelva a otra ruta y archivos existentes que sean symlink/reparse o tengan más de un hardlink. La prueba usa un hardlink sintético y una junction; ambos se rechazan y el archivo destino queda intacto. Esta defensa del harness no cierra una sustitución TOCTOU entre validación y apertura. El store JSON de M.1d.1 mantiene sus comprobaciones existentes de directorio y symlink, pero no demuestra una política contra hardlinks.

Una muestra diagnóstica de una escritura y reapertura midió aproximadamente 5,7 ms para JSON y 0,7 ms para SQLite en esta máquina. No es un benchmark estadístico ni base para decidir rendimiento; no se midió carga, latencia p95, volumen de sesiones ni retención.

## Node y dependencias

El entorno usó Node `v22.14.0`. `node:sqlite` está disponible sin instalar paquetes, pero Node emite `ExperimentalWarning` y la API está marcada experimental en esta versión. Por lo tanto, disponibilidad, estabilidad, opciones del constructor y soporte operativo dependen de la versión exacta de Node; este resultado no aprueba `node:sqlite` para producción ni constituye soporte a largo plazo. No se modificó `package.json`, lockfile, PATH ni software del sistema.

SQLite facilita transacciones de varias filas, CAS en la sección crítica, recuperación de journal y concurrencia de lectores/escritores cooperativos. Añade manejo de WAL/SHM, checkpoints, compatibilidad de versión, backups consistentes y una dependencia fuerte del contrato de mantenimiento de Node o de un paquete SQLite mantenido. JSON es más sencillo, inspeccionable y ya dispone de lock, digest, CAS, staging y reconciliación probados en el repositorio. La comparación no sustituye esas pruebas existentes.

## Qué no demuestra

- `synchronous=FULL` y `fsync`/`sync` se probaron como configuración y llamadas de API, no como supervivencia ante pérdida eléctrica, fallo del controlador o almacenamiento que mienta sobre flush.
- No se probó atomicidad universal entre filesystems, antivirus, sincronizadores, software de backup ni escritores externos que ignoren el lock.
- Una terminación de proceso no equivale a corte de energía. NTFS fue el volumen ensayado; no se generalizan resultados a red, FAT, ReFS u otros volúmenes.
- No se probó protección contra rollback. Un backup antiguo válido se aceptó en ambos formatos; una restauración válida no se diferencia de un estado actual sin un ancla independiente.
- La pérdida o eliminación completa del store permite inicializar una instalación sintética nueva. Una autoridad de identidad futura debe ligar la instalación a un ancla protegida fuera del archivo/DB y bloquear el bootstrap si desaparece un store ya registrado.
- La inicialización del harness no distingue una instalación genuinamente nueva de la eliminación del archivo de una instalación previa. Un contrato futuro de continuidad debe clasificar explícitamente: **instalación nueva** (bootstrap permitido una sola vez); **store existente y sano** (continuar tras validar su identidad); **store ausente para una instalación ya registrada** (bloquear, nunca tratarlo como nuevo); **estado corrupto** (cuarentena/bloqueo, sin reparación silenciosa); **restauración sospechosa** (bloquear y requerir reconciliación con una ancla independiente); y **recuperación expresamente autorizada** (flujo autenticado, auditado y con revisión/época nuevas). Este batch no implementa esa clasificación ni una fuente autoritativa para distinguir esos estados.
- La ACL no depende del motor. Persisten los límites de M.1e.3: handles nativos para cerrar TOCTOU, DACL productiva compatible con backups/servicios, aislamiento frente a procesos del mismo usuario, administrador y malware local. DPAPI CurrentUser y Credential Manager no se probaron.
- Ni JSON ni SQLite autentican a una persona, protegen secretos por sí solos, conceden permisos o separan recuerdos privados. Las claves futuras, sesiones, epochs y particiones requieren un broker confiable y decisiones de privacidad independientes.
- El harness SQLite solo persiste un snapshot serializado en una fila para comparar transacciones. No es una propuesta final de esquema relacional, migración, backup ni repositorio de producción.

## Recomendación para el MVP

**No reemplazar el store actual en este batch.** Para el MVP local de una autoridad de identidad pequeña y escritor único, mantener el JSON existente es la opción de menor complejidad: ya ofrece CAS, lock cooperativo no robable, digest, staging atómico por rename y reconciliación, sin API experimental ni paquetes nuevos. SQLite muestra mejores primitivas transaccionales para estado normalizado y concurrencia de lectores; sería candidata preferible si el diseño evoluciona a múltiples tablas y si se fija un runtime/API SQLite estable y soportado. Antes de adoptarla se necesitan pruebas de backup/checkpoint, migración, recuperación, bloqueo por antivirus y operación en la matriz de Windows soportada.

Esta recomendación no afirma durabilidad universal del JSON ni descarta SQLite como destino. Ninguna alternativa debe habilitarse hasta resolver ancla antirrollback, tratamiento de store ausente, autenticación Owner real, ACL/handles, recuperación de backups, secretos de sesión y política de revocación.

## Validación de M.1e.4

Windows 11, volumen temporal NTFS, Node `v22.14.0`:

- M.1e.4 focalizada: **17 aprobadas, 0 omitidas, 0 fallos**.
- M.1e.3: **16 aprobadas, 1 omitida, 0 fallos**. Windows denegó crear un symlink de directorio; la junction sí se probó.
- M.1d.1/M.1c/C.5f/C.5g: **78 aprobadas, 1 omitida, 0 fallos**. La omisión de M.1d.1 fue el symlink de archivo no disponible en el entorno.
- Memory: **308 aprobadas, 0 omitidas, 0 fallos**.
- Automatic Memory: **236 aprobadas, 0 omitidas, 0 fallos**.
- Suite completa: **831 aprobadas, 2 omitidas, 0 fallos**.
- Sintaxis JavaScript, whitespace y `git diff --check`: aprobados.

Memory1 conserva SHA-256 `41F995007782BDDF665C39EA9F69B2B699C90329D1D0CAEC61F4307154773B68`; no se leyeron sus entradas. El backend sigue siendo `memory1`, `data/memory-v2.json` sigue ausente, Automatic Memory permanece desactivada y no existe `%LOCALAPPDATA%\Nexa\Identity`. No se ejecutó Windows Hello ni hubo llamadas a OpenAI. El working tree contiene únicamente los archivos experimentales M.1e.4 y esta documentación; no se hizo commit ni push.
