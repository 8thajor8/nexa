# M.1e.3 — Prototipo aislado de directorio de identidad en Windows

## Alcance y aislamiento

Este batch añade `src/core/experimental/secure-identity-directory.js`, una prueba focalizada y este documento. El prototipo no se importa desde el agente, `src/index.js`, tools, dispatcher ni `identity-store.js`. Solo acepta un directorio ya existente cuyo nombre empiece por `nexa-m1e3-`, situado bajo el directorio temporal del sistema, y crea dentro el subdirectorio `Identity`. Rechaza la ruta real `%LOCALAPPDATA%\Nexa\Identity`; no inicializa identidades, Owner, credenciales ni sesiones.

Los archivos temporales contienen exclusivamente sondas sintéticas. El módulo devuelve `executable: false`, `authorization: DENY` y `persistencePerformed: false` en sus resultados. No escribe Memory1/Memory2, no cambia configuración de Windows, no usa red ni OpenAI y no añade dependencias.

## Herramientas utilizadas

- Node `fs/promises`: crea el directorio y una sonda exclusiva; comprueba `lstat`, `realpath`, identidad de archivo, lectura, escritura, sincronización, renombrado y eliminación.
- Windows PowerShell 5.1: un script fijo, invocado con `spawn` y `shell: false`, aplica una DACL y obtiene las ACEs interpretadas por .NET (`GetAccessRules`), junto con el propietario, el SID actual y el estado de protección de herencia. El proceso recibe la ruta por una variable de entorno, no interpolada en el script. Se limita `PSModulePath` a los módulos del Windows PowerShell del sistema para evitar colisiones de módulos de la sesión padre.
- `icacls.exe`, exclusivamente en tests, agrega ACEs adversariales a directorios temporales. Se invoca con argumentos separados y `shell: false`; nunca se ejecuta contra rutas reales.

La validación no compara una cadena SDDL. Inspecciona propietario y cada ACE como SID, `Allow`/`Deny`, derechos, herencia y procedencia explícita/heredada. También pide al proceso actual realizar operaciones reales de filesystem. Esto comprueba el acceso efectivo del token actual para las operaciones de prueba. No calcula el acceso efectivo de tokens de otras cuentas ni suplanta esas cuentas.

## Política ACL del prototipo

El directorio queda con herencia protegida y una sola ACE explícita: `FullControl` para el SID del usuario actual, heredable a subdirectorios y archivos. El propietario debe ser ese mismo SID. Se rechazan ACEs adicionales, denegaciones explícitas, ACEs heredadas, permisos distintos y un propietario diferente. SYSTEM y Administrators no reciben ACE explícita en este prototipo por usuario. Esta DACL estricta puede interferir con servicios de backup, antivirus, indexación o administración que necesiten acceso; por eso no debe copiarse como política productiva sin decidir expresamente qué identidades operativas requieren acceso. Un administrador local aún puede tomar posesión o alterar el sistema; esa amenaza está fuera de las garantías aceptadas para el MVP.

Los archivos de prueba heredan la ACE del directorio y se inspeccionan antes de que la sonda se lea. Las pruebas agregan permiso `Everyone`, una denegación y una herencia amplia en el padre para demostrar que el validador rechaza las primeras y que la aplicación protege la DACL hija frente a la última.

## Rutas, reparse points y limpieza

El prototipo comprueba que la raíz temporal sea una carpeta real, que su ruta resuelta coincida con la solicitada y que el directorio creado no tenga `FILE_ATTRIBUTE_REPARSE_POINT`. La comprobación detecta symlinks, junctions y también el bit de reparse aunque el tipo concreto no sea reconocido por el código. Antes y después de aplicar la ACL, y antes y después de la sonda, vuelve a comparar la identidad disponible del directorio. En Windows se usa el índice de archivo (`ino` de Node), porque `dev` no fue estable entre `lstat()` y `handle.stat()` en el store existente.

La limpieza solo elimina un directorio vacío si todavía coincide su identidad y no es un reparse point. Si hay contenido inesperado, cambió la identidad o no se puede validar la ruta, devuelve `residue` y deja el residuo para inspección. La sonda verifica identidad antes de retirar sus archivos; si falla su escritura o limpieza, la verificación se rechaza y el resultado incluye `cleanupCode` y `residueMayRemain` cuando corresponde. La causa primaria se conserva y no se comunica aceptación si la limpieza falla. La limpieza recursiva de la raíz temporal pertenece al `t.after()` de cada test y solo opera en la fixture que ese test creó.

La carrera inducida en la prueba sustituye la carpeta entre la comprobación inicial y la aplicación de ACL. El prototipo detecta la junction y no altera el destino. Sin embargo, **las APIs de ruta de Node no permiten demostrar que la ruta no será sustituida entre la última comprobación y cada operación posterior**. Las comprobaciones repetidas reducen y detectan algunas carreras reproducibles; no eliminan TOCTOU. Un broker real necesitará operar sobre handles Windows verificados, APIs nativas con semántica no-follow y, cuando aplique, operaciones relativas a un handle. No debe integrar este módulo como frontera productiva.

## Pruebas y garantías

`test/memory-m1e3-secure-identity-directory.test.js` contiene pruebas sintéticas de:

- DACL válida, propietario, ACE adicional, permisos, herencia y `Deny`.
- Acceso efectivo del proceso actual y ACL heredada por un archivo de prueba.
- Herencia amplia en el padre, ACEs explícitas `Everyone` y denegación de acceso.
- Symlink y junction de directorio; sustitución por junction entre validación y uso.
- Bit de reparse point con etiqueta desconocida simulada. No se crea un reparse tag nativo arbitrario, porque eso exige una fixture Win32 especializada; la detección del bit se prueba con el valor de atributo sintético.
- Raíz ausente, archivo en lugar de directorio, raíz fuera de Temp, propietario/observación incorrectos, fallo de aplicación, ACL malformada, y limpieza segura ante residuo.
- Ausencia de imports desde runtime, agente y tools.

El subtest de enlaces de la raíz intenta crear primero un symlink de directorio (`type: dir`) y luego una junction. En la ejecución auditada Windows denegó la creación del symlink (`EPERM`/privilegio de creación no disponible), por lo que ese subtest fue `SKIP`; la creación de junction sí funcionó y se ejecutó. La sustitución de la carpeta objetivo por una junction y la sustitución de la raíz por una junction también se probaron y pasaron. Si Windows no permite crear alguno de esos enlaces por `EPERM`, `EACCES`, `ENOTSUP` o `EOPNOTSUPP`, solo se omite esa fixture concreta con causa visible. El bit `FILE_ATTRIBUTE_REPARSE_POINT` desconocido se comprueba con una observación sintética, no mediante creación de un tag nativo. Los errores de aplicación o validación ACL son `FAIL`, no se convierten en skip.

La auditoría M.1e.3 agrega una inyección sintética donde falla la escritura de la sonda y también su limpieza. Debe conservarse el error de operación, devolver rechazo e informar el código de limpieza y el posible residuo. Las pruebas adversariales de ACL y filesystem usan carpetas temporales creadas por los tests; no se cambian privilegios globales.

Validación final ejecutada en Windows 11 con Node `v22.14.0`: M.1e.3 focalizada **16 aprobadas, 1 omitida** (Windows denegó crear el symlink de directorio; la junction se probó y pasó); M.1d.1/M.1c/C.5f/C.5g **78 aprobadas, 1 omitida**; Memory **290/290 aprobadas**; Automatic Memory **236/236 aprobadas**; suite completa **813 aprobadas, 2 omitidas, 0 fallos**. La suite completa omite exactamente dos fixtures de enlace: M.1e.3 no pudo crear un symlink de directorio, y M.1d.1 no pudo crear un symlink de archivo (`filesystem does not permit synthetic file symlinks`). Son restricciones del entorno de prueba, no fallos convertidos en skips; las pruebas de junction disponibles sí se ejecutaron. Los tests que necesitan filesystem temporal se ejecutaron con escritura limitada a carpetas sintéticas temporales.

Queda demostrado que, en este Windows y bajo el token actual, se puede aplicar e inspeccionar la DACL indicada, hacer las operaciones de sonda y rechazar las configuraciones adversariales ensayadas. No queda demostrado el aislamiento real frente a otra cuenta, un proceso malicioso con el mismo usuario, un administrador, ni frente a una carrera arbitraria. Tampoco se prueba un ACL efectivo para cada miembro de grupos locales en un token diferente.

## Límites y política de fallo

La ACL limita acceso entre cuentas si se configura correctamente, pero no crea una frontera entre procesos bajo el mismo SID. DPAPI y Credential Manager aún no forman parte de este prototipo. Tampoco se crea una ubicación de producción ni se define si un futuro servicio necesitaría acceso SYSTEM.

Un cambio ACL inesperado, reparse point, propietario distinto, directorio ausente, acceso denegado o resultado incierto debe bloquear operaciones administrativas futuras. No se debe reparar automáticamente la ACL ni aceptar una ubicación alternativa. Una restauración desde backup necesita revisión; este prototipo no detecta rollback.

## Recomendación para M.1e.4

Mantener el store sintético actual fuera del runtime. Antes de elegir JSON o SQLite, probar en NTFS una autoridad de escritor único, recuperación tras proceso terminado, integridad tras fallos, herencia ACL en archivos auxiliares, backup/restauración y comportamiento con antivirus. El resultado debe incluir una decisión separada sobre handles nativos para cerrar TOCTOU; el presente módulo no es base suficiente para producción. No crear un Owner real ni conectar el prototipo hasta una etapa posterior aprobada.
