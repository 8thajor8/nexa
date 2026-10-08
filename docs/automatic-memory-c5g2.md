# Automatic Memory C.5g.2 — motor de autorización por usuario

## Alcance

`src/core/authorization-engine.js` contiene una evaluación pura de política sobre contratos de datos. No es autenticación, no crea grants, no emite capacidades ni ejecuta acciones. El módulo no está conectado al agente, dispatcher de tools, permisos globales, coordinador B.2b, context provider ni repositorio Memory2. No cambia los permisos actualmente efectivos.

La entrada `mode: "hypothetical"` permite evaluar fixtures y puede producir `ALLOW`, pero la salida siempre declara `executable: false`. `mode: "execution"` siempre produce `DENY` antes de evaluar las claims, incluso si parecen válidas. Los datos sintéticos no son utilizables como autenticación de producción.

## Contrato de decisión

La solicitud aporta principal, instalación/directorio, sesión, dispositivo opcional, grants explícitos, operación, requisitos, nivel de riesgo y revisiones esperada/actual. El resultado contiene:

- `decision`: `ALLOW` o `DENY`.
- `mode`: hipotético o ejecución.
- `executable`: siempre `false` en este motor.
- `reasonCode` y requisitos adicionales para auditoría o step-up.
- Metadatos mínimos: versión de política, principal en modo hipotético, acción y recurso.

La forma se valida estrictamente y rechaza campos extra/accessors. La cabecera de la solicitud debe coincidir exactamente con al menos un requisito primario (acción, recurso y ámbito); para acciones distintas de `execute`, los requisitos no pueden contradecir la acción. En una ejecución de tool, la autorización de la tool se vincula a su nombre exacto y los permisos de datos siguen siendo requisitos separados. Los grants deben usar ámbitos y namespaces admitidos para su permiso, además de coincidir con principal, instalación y época.

El modo hipotético comprueba que la cuenta esté activa y declarada autenticada, que directorio e Owner sean consistentes, que sesión y dispositivo correspondan al principal y a la instalación y no estén vencidos/revocados, y que las revisiones coincidan. Si una sesión tiene `deviceId`, el registro correspondiente es obligatorio incluso si la solicitud no marca `deviceRequired`; si la sesión no está vinculada a un dispositivo, un registro de dispositivo adicional se rechaza. El contrato estructural de dispositivo incluye la instalación. Estas comprobaciones evalúan coherencia de fixtures, no la verdad de sus claims.

## Política Owner-first

- Hay un único slot Owner por instalación. En modo hipotético, la administración requiere Owner activo, autenticación de nivel fuerte y un grant `admin.*` explícito, vigente, limitado al recurso y emitido por el Owner.
- Member nunca puede ejecutar acciones administrativas, incluso con un grant sintético `admin.*`.
- Owner no tiene bypass de grants y no obtiene acceso a memoria privada ajena por su rol.
- La lectura de datos privados de otra persona requiere además consentimiento separado, ligado al sujeto, destinatario y vigencia. Consentimiento y grant en estos fixtures son datos; en ejecución no se aceptan como autoridad.
- Acceder a memoria propia, privada, compartida, instalar herramientas o administrar usuarios son permisos distintos. Cada requisito debe tener un grant exacto por principal, instalación, época, permiso, recurso y ámbito.
- Grants globales `*` no son válidos. El patrón limitado `namespace.*` no cruza namespaces. Grant expirado, revocado, fuera de ámbito, de otra cuenta/instalación/época o con grantor no Owner se rechaza.
- Ejecutar una tool requiere un permiso `tool.execute` para esa tool y, además, cada permiso de datos que la operación necesite. Permiso Spotify no autoriza correo; permiso de tool no equivale a acceso a todo dato que esa tool pueda devolver.
- Una sesión obsoleta, un dispositivo revocado o una revisión distinta provocan denegación. Las acciones críticas requieren autenticación fuerte y confirmación independiente en la evaluación hipotética; esos flags no se aceptan para ejecución.

Categorías preparadas sin grants efectivos:

| Dominio | Ejemplos de permisos | Recursos/ámbitos esperados |
| --- | --- | --- |
| Herramientas y aplicaciones | `tool.execute` | `tool.windows_*`, `tool.spotify_*`, `tool.email_*`, `tool.whatsapp_*` |
| Datos | `data.read`, `data.write` | mensajes, calendarios, archivos u otros recursos concretos |
| Servicios externos | `external.action` | operación externa específica |
| Memoria | `memory.personal.read`, `memory.private.read`, `memory.shared.read`, `memory.write` | persona y ámbito `own`, `private` o `shared` |
| Automatizaciones | `automation.manage` | automatización concreta |
| Administración | `admin.users`, `admin.devices`, `admin.permissions` | instalación y recurso administrativo exacto |
| Integraciones futuras | permisos del dominio correspondiente, incluido Lifeguard | sin acceso ni grants creados ahora |

La tabla es vocabulario de evaluación, no una política conectada a herramientas o integraciones.

## Fronteras y puntos de integración futuros

Hoy, `src/tools/permissions.js` conserva una política global por categoría y no evalúa principal, recurso ni privacidad por usuario. C.5f representa stdin como origen local no autenticado; el principal derivado de SID se declara no verificado y Windows Hello continúa fail-closed. Memory2 conserva un único `self_person_id`; su context provider no aplica separación por principal. B.2b conserva su propia capability/autorización de operación y su writer no consulta este motor.

La integración futura requiere, como mínimo: proveedor de autenticación nativo; registro durable y transaccional de principal/Owner/Member; grants verificables y revocables; sesión emitida por boundary confiable; confirmación independiente para alto riesgo; una frontera de tools que evalúe antes de ejecutar; scopes de memoria por usuario; adaptación de B.2b en su propio límite de escritura; y auditoría con protección contra manipulación. No se debe llamar a `evaluateAuthorizationPolicy()` desde el modelo ni tratar su resultado hipotético como grant.

## Cobertura y límites

Las pruebas son sintéticas y cubren modo de ejecución siempre DENY, autenticación ausente, Member/Owner, grants y recursos exactos, expiración/revocación, sesiones/dispositivos, revisión obsoleta, step-up, consentimiento privado, aislamiento de dos usuarios, separación tool/datos y rechazo de cabeceras contradictorias o de sesiones ligadas a dispositivos sin registro concordante. Los ALLOW de pruebas solo prueban la política hipotética y no una autenticación real. Cualquier entrada hipotética, incluso si fuese construida por un modelo, permanece como dato no confiable y nunca se convierte en autoridad ejecutable.

No se han probado ni implementado autenticación, emisión de grants, revocación durable, concurrencia, protección contra rollback del registro, consentimiento real, ejecución de herramientas, acceso multiusuario a memoria ni auditoría operativa. En particular, comparar números de revisión aportados a una evaluación no asegura frescura por sí solo: una futura integración debe leer la versión actual dentro de la frontera transaccional. La identidad de una sesión local no es identidad humana. El motor no sustituye controles existentes y no concede bypass al Owner.

## Estado

Memory1 permanece como backend efectivo. Memory2, Automatic Memory y el extractor real continúan desactivados. No se crean cuentas, dispositivos, sesiones, grants ni datos personales. No hay llamadas a OpenAI, escrituras de memoria ni dependencias nuevas.
