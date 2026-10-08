# Automatic Memory C.4 — Verificación de retención del proveedor

**Verificado:** 2026-10-08 mediante documentación oficial de OpenAI. Revalidar antes de habilitar cualquier llamada de Automatic Memory; la política y la configuración de cuenta pueden cambiar.

## Flujo Nexa contemplado

El extractor A usa OpenAI Responses API (`/v1/responses`) y `src/brain/openai.js` establece `store: false`. El detector no se compone en la CLI de producción en C.4; por tanto, en esta fase no hubo llamadas de Automatic Memory. Una futura llamada, si se autoriza, transmitiría como mínimo el texto directo del turno que haya pasado el filtro y el formato de instrucciones/schema de extracción. El consentimiento persistente no activa este flujo por sí solo.

`store: false` es una opción de estado de la respuesta; **no debe comunicarse como “retención cero”**. La documentación oficial separa al menos estos conceptos:

| Capa | Hecho documentado para la API | Implicación para Nexa |
| --- | --- | --- |
| Uso para entrenamiento | La página oficial indica que datos enviados por API no se usan para entrenar/mejorar modelos salvo opt-in explícito. | No equivale a no almacenamiento operativo. |
| Abuse monitoring logs | De forma predeterminada pueden contener prompts/respuestas y metadatos, con retención de hasta 30 días, salvo excepción legal o de seguridad. | No es neutralizado por `store:false`. |
| Estado de Responses | Responses tiene retención de estado de aplicación de 30 días por defecto o con `store:true`; la página explica límites y excepciones. El extractor actual pide `store:false`. | No asumir que todos los objetos/funciones del endpoint tienen la misma semántica. Verificar la solicitud completa y las features usadas antes de un piloto real. |
| Zero Data Retention / Modified Abuse Monitoring | Controles disponibles para organizaciones/proyectos elegibles, sujetos a aprobación previa y requisitos; ZDR cambia cómo se trata `store` para Responses. La página también describe limitaciones/excepciones de modelos/features. | No está confirmado si la organización/proyecto de Nexa es elegible, aprobada o tiene alguno configurado. No afirmar ZDR. |
| Otros componentes | Herramientas/servicios de terceros tienen sus propias reglas. La página identifica excepciones de features y posibles estados de aplicación adicionales. | El extractor previsto no adjunta tools; cualquier cambio requiere nueva revisión. |

## Retención local Nexa

- **Texto de turno:** permanece en el flujo de conversación normal mientras vive el agente. Para evaluación se conserva temporalmente un solo turno, con límite de caracteres, después de una respuesta textual completa y solo bajo consentimiento+composición explícita. Timeout de cinco segundos invalida el resultado; un detector no cooperativo puede mantener recursos/texto hasta que su promesa termine o el proceso cierre.
- **Consentimiento:** registro local mínimo versionado. No contiene texto, desafío ni token reutilizable. Se conserva hasta revocación o reemplazo por nueva versión; revocar escribe un tombstone.
- **Propuestas:** C.4 no conecta el detector a la cola. La infraestructura acepta resúmenes/target summaries acotados, nunca el turno original. Pendientes expiran a siete días y se scrubean al comprobar vencimiento; rechazados se scrubean enseguida; tombstones terminales se purgan después de 30 días; propuestas aprobadas mantienen el resumen hasta su expiración de siete días. Los contenidos pueden ser sensibles y se almacenan en claro dentro de la carpeta local protegida por permisos/ACL del usuario.
- **Recuerdos:** no se escriben en C.4. Cualquier retención de Memory1 o Memory2 pertenece a sus propios archivos y consentimiento de escritura; no la modifica este documento.
- **Auditoría:** diagnósticos C.4 usan códigos/recuentos y no incluyen el texto, resumen, desafío, clave o capability. No hay registro de solicitud del proveedor porque no se hacen llamadas.

## Límites y condición previa

La documentación pública no revela la configuración efectiva de retención, controles aprobados, proyecto o contrato de esta cuenta. No se accedió a la cuenta ni a credenciales. Tampoco se verificó configuración contractual de almacenamiento. La retención de la organización/proyecto debe confirmarse por el dueño de la cuenta en Platform antes de enviar contenido real. C.4 no requiere ni realiza esa consulta.

Antes de una prueba real, revisar nuevamente esta página oficial y confirmar el modo efectivo de retención del proyecto/modelo/endpoint, las opciones de almacenamiento del request, si se necesita y está aprobado ZDR/MAM, y los límites/excepciones aplicables. Establecer corpus ficticio, presupuesto y número de llamadas en autorización separada. Si no puede verificarse la configuración requerida, no enviar mensajes reales.

## Fuente oficial

- [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data?popup=false), consultada 2026-10-08. Incluye tratamiento de datos de API, abuse monitoring, ZDR/MAM, estado de Responses y limitaciones.
- [Create a model response — Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create), consultada 2026-10-08. Referencia del parámetro `store` y retención de objetos response.

\n