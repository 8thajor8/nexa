# M.1e.5b.4a — Preparación del laboratorio WebAuthn nativo

## Alcance y resultado

Esta fase prepara una especificación de laboratorio y un verificador offline; no contiene un invocador de ceremonias nativas. No ejecutó WebAuthn ni Windows Hello, no creó credenciales y no registra Owner, sesión o identidad. No se conectó al runtime ni se modificó el store.

Se agregaron únicamente tres archivos de laboratorio:
- test/support/webauthn-native-proof-verifier.js
- test/memory-automatic-m1e5b4a-native-lab.test.js
- docs/memory-m1e5b4a.md

El verificador es test-only y acepta solo RP ID nexa-memory-lab.test y origin https://nexa-memory-lab.test. No acepta el origin desde el bundle. Sus resultados siempre dicen DENY, executable false y persistencePerformed false; originBinding queda en caller_supplied_unverified. La validación de firma demuestra integridad de bytes bajo una clave pública, no identidad humana ni del proceso.

## Tecnología elegida

Para una futura prueba nativa se recomienda un ejecutable C++ Win32 separado que use la API WebAuthn del sistema y los tipos versionados de webauthn.h. Microsoft documenta soporte en Windows 11 y funciones MakeCredential/GetAssertion que reciben HWND, RP ID y WEBAUTHN_CLIENT_DATA. Se evita instalar paquetes y se reduce marshalling manual de P/Invoke. Fuentes: [API WebAuthn de Windows](https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis), [MakeCredential](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthnauthenticatormakecredential), [GetAssertion](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthnauthenticatorgetassertion).

.NET P/Invoke podría servir para un spike, pero reproduce estructuras C y requiere cuidado de versiones y liberación de memoria. FFI Node agregaría acoplamiento y no aislaría la autoridad. Una WebView vuelve a introducir el problema de origen. La prueba debe usar un caller Win32 desechable; esto no determina la arquitectura productiva.

El entorno tiene Node 22 y .NET Runtime 8, pero no MSVC, Windows SDK, CMake ni .NET SDK. No se puede compilar ni comprobar un host nativo sin instalar herramientas, fuera del alcance. Por eso no se agregó código nativo sin compilar. Antes de una ceremonia se necesita un entorno que ya tenga Visual Studio Desktop C++ y Windows SDK.

## RP ID y origin

La API Win32 recibe RP ID y bytes JSON clientData proporcionados por el caller. El autenticador firma el hash de clientData, lo que liga el origin declarado a la firma, pero no prueba por sí solo quién construyó el JSON ni qué ejecutable llamó a la API. La documentación de Windows no establece en estas llamadas una prueba criptográfica de identidad del binario. La W3C exige que el RP valide el origin; no se debe inferir que el API nativo hace el binding de aplicación. Fuentes: [WEBAUTHN_CLIENT_DATA](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/ns-webauthn-webauthn_client_data), [validación de origin W3C](https://www.w3.org/TR/webauthn-3/#sctn-rp-origin-validation).

El laboratorio fija RP ID nexa-memory-lab.test y origin https://nexa-memory-lab.test; no usa dominio de Nexa. El origin alternativo será https://other-lab.test. El sufijo .test está reservado para pruebas. localhost no se elige: su ámbito es compartido localmente y el puerto no separa el RP ID. Dominio HTTPS controlado daría semántica web, pero requiere diseño e infraestructura aún no aprobados.

El verificador acepta solo el origin fijado. Rechazar una respuesta firmada con otro origin comprueba consistencia de datos, no que Windows haya vinculado el origin al caller. Si una llamada nativa acepta clientData cuyo origin alternativo fue construido por el caller, eso demostraría precisamente que el campo no identifica al ejecutable.

## Verificador independiente

El verificador procesa en memoria los campos estándar del response JSON de Windows. Verifica JSON UTF-8 acotado sin claves duplicadas, base64url canónico, challenge, type, origin, RP ID hash, UP/UV y flags. Para registro acepta solo attestation fmt=none y attStmt vacío, sin extensiones, y extrae credential ID y clave COSE EC2/P-256 ES256. Para assertion compara el credential ID proporcionado en el contexto y verifica ES256 sobre authenticatorData concatenado con SHA-256(clientDataJSON). Ese contexto y el challenge esperado son entradas del caller; este verificador no consulta un registro de credenciales autoritativo ni emite los challenges.

Los errores se reducen a códigos permitidos; la sanitización no evalúa getters de valores arrojados y también falla cerrada ante traps hostiles de Proxy. El test adversarial cubre ambos casos.

`valid: true` significa únicamente que la estructura y, para assertion, la firma coinciden con los datos esperados suministrados. No significa autenticación, credencial conocida ni autorización: cada resultado continúa siendo `DENY`, no ejecutable y no persistente. El verificador es sin estado: una prueba idéntica puede validarse repetidamente y reutilizar un challenge no se detecta. El contador se reporta como dato, no como garantía general anti-replay. Un broker futuro deberá emitir challenges frescos ligados a una operación exacta, principal, instalación y expiración, y consumirlos atómicamente una sola vez antes de poder tratar el resultado como evidencia de autenticación. Este verificador no implementa ese flujo.

`fmt=none` no contiene firma de attestation: no demuestra modelo de autenticador, hardware ni Windows Hello. Los flags UP/UV tampoco identifican a una persona. El parser CBOR es limitado a este formato de laboratorio, no un parser general ni un verificador de producción.

## Matriz para el siguiente batch

| Prueba | Variación | Observación | No demuestra |
|---|---|---|---|
| Origin esperado | Origin y RP ID fijos | Verificador acepta estructura y firma | Binding al ejecutable |
| Origin alterado | Cambiar solo origin, mantener RP ID | Observar si API produce respuesta; verificador fijo la rechaza | Identidad del caller |
| RP ID alterado | RP diferente de la credencial | Observar error o ausencia de credencial | Política universal de autenticadores |
| Segundo proceso | Mismos parámetros desde otro proceso | Observar si existe límite por proceso | Autenticación de proceso |
| Binario diferente | Caller alternativo, si el entorno lo permite | Observar exclusividad por artefacto | Binding al binario firmado |
| Contexto web | Navegador HTTPS de laboratorio ya confiable | Comparar respuesta de navegador con native | Equivalencia entre APIs |

No instalar certificados raíz ni crear infraestructura productiva. Si el contexto web fiable no está disponible, omitirlo y documentar el prerrequisito.

## Procedimiento previsto

No hay comando ejecutable aún: falta implementar y compilar el caller nativo. En un batch posterior, el procedimiento debe ser: confirmar checkout limpio; usar solo toolchain ya instalada, sin elevar; compilar un caller aislado que fije RP/origin por código y no acepte parámetros no confiables; mostrar confirmación humana separada para registro y assertion; generar challenges CSPRNG y user handle aleatorio; solicitar attestation none, solo ES256, UV requerido y sin extensiones; exportar únicamente proof bundles necesarios a archivos temporales fuera del repo; verificar registro y assertion con este módulo; probar variantes una por vez sin reintentos; cerrar el proceso y borrar solo proof bundles cuya ruta y hash hayan sido comprobados.

La credencial no se eliminará programáticamente. Tras la prueba, quitar manualmente solo la entrada con RP nexa-memory-lab.test y etiqueta explícita de laboratorio desde el gestor del autenticador. Si no puede identificarse sin ambigüedad, no borrar nada. La API WebAuthNDeletePlatformCredential existe para credenciales de plataforma, pero no garantiza borrar credenciales sincronizadas o de llaves externas; no se usará en el primer spike. [Documentación de borrado](https://learn.microsoft.com/en-us/windows/win32/api/webauthn/nf-webauthn-webauthndeleteplatformcredential).

Este procedimiento es el protocolo previsto, no un comando listo para ejecutar. Caller nativo, revisión de su exportación/liberación de buffers y autorización de la ceremonia quedan pendientes.

## Validación y estado

Las pruebas del batch usan pares ES256 generados en memoria. No llaman a Windows ni crean credenciales. El test normal no lanza subprocesos ni tiene un script para ceremonia. No se añadieron dependencias.

En la inspección inicial, HEAD, main y origin/main estaban alineados y el árbol limpio en 4aaa395d3f96d60ba8700d848adfa16f468e22f4. Memory1 tenía SHA-256 41F995007782BDDF665C39EA9F69B2B699C90329D1D0CAEC61F4307154773B68; backend efectivo memory1; NEXA_MEMORY_BACKEND sin definir. No existía data/memory-v2.json ni %LOCALAPPDATA%\Nexa\Identity. Automatic Memory estaba desactivada. No hubo llamadas a OpenAI, cambios a stores ni procesos nativos.
