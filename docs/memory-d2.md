# Memory D.2 — Relaciones entre entidades

## Estado previo reutilizado

Schema v5 ya representa una relación como una assertion normal: sujeto `entity`, predicado relacional registrado, objeto `entity_reference`, evidencia y source. Las entidades siguen siendo las mismas entidades canónicas del store; D.2 no crea un grafo persistente ni otra colección. El catálogo actual de [`relation-predicates.js`](../src/memory/relation-predicates.js) contiene únicamente `partner_of`, con endpoints Person, simetría explícita, cardinalidad `many` y prohibición de autorrelación. El esquema valida tipos, existencia de endpoints, orden canónico para la relación simétrica, evidencia y referencias de supersession.

El retriever ya selecciona relaciones directas, aplica vigencia mediante D.1 y limita el vecindario para el proveedor de contexto. D.2 no reemplaza esas rutas ni las conecta a producción; agrega una descripción pura y consultas sintéticas sobre entradas que el caller ya obtuvo.

## API simulada

`src/memory/relationship-semantics.js` exporta:

- `describeRelation(...)`: valida una assertion relacional, los dos registros Person, evidencia/source y sus referencias. Devuelve IDs de endpoints, predicado, indicador de simetría del catálogo, estado temporal de D.1 y metadatos mínimos de evidencia. No devuelve nombres ni valores de evidencia, y etiqueta la verdad de la relación como no verificada independientemente.
- `queryRelations(...)`: evalúa relaciones directas desde una entidad, opcionalmente entre dos entidades exactas y/o por predicado. Exige un único `asOf` en toda la consulta, rechaza assertion IDs duplicados y scope labels distintos. No busca caminos ni aplica transitividad. La salida preserva sujeto y objeto almacenados; la coincidencia inversa solo se permite si el catálogo declara simetría. Las entradas y resultados tienen orden estable por assertion ID. Los avisos de duplicados se calculan solo dentro del subgrafo seleccionado, no sobre relaciones ajenas a la consulta.

Los estados `active`, `historical`, `future` y `unknown` son estados temporales derivados de D.1. Un intervalo futuro no se muestra activo. D.2 no contiene una intención persistida de plan para relaciones: cuando el esquema no distingue plan de hecho, una fecha futura se informa como futura, no como plan confirmado. Evidencia presente no acredita por sí sola que la relación sea verdadera.

El catálogo no define incompatibilidades semánticas entre predicados. D.2 rechaza predicados relacionales desconocidos y endpoints incompatibles; detecta enlaces duplicados con el mismo predicado, endpoints normalizados según la regla de simetría e intervalo de vigencia. No infiere que dos predicados diferentes sean incompatibles. Esa política queda fuera de D.2 y no implementa contradicciones D.3.

## Ámbito y privacidad

El formato de assertion/evidence de Schema v5 no lleva propietario de partición ni ámbito privado/compartido. Cada entrada de D.2 requiere un `scopeLabel` efímero para rechazar mezclas **declaradas** dentro de una consulta. Esa etiqueta es metadata no confiable del caller: no autentica, no concede acceso y no demuestra que la lista provenga de una partición real. D.2 no abre repositorios, no selecciona particiones y no puede detectar una mezcla si el caller la oculta o etiqueta de forma uniforme.

Antes de invocar estas funciones, una capa externa debe autenticar/autoriz-ar la lectura, filtrar a una única partición y ámbito y pasar solo ese snapshot. D.2 no resuelve Self por texto o procedencia, no atraviesa ámbitos, no da permisos y no expone valores de assertions. Los IDs de endpoints y assertions siguen siendo datos privados; solo deben mostrarse al consumidor que ya esté autorizado para el snapshot.

Una solicitud `mode: 'execute'` devuelve `DENY`, una lista vacía y `executable: false`. Las consultas simuladas también devuelven `executable: false` y `persistencePerformed: false`. No hay escritores, efectos persistentes, integración con agente/CLI/Automatic Memory ni llamadas a OpenAI.

## Pruebas y límites

`test/memory-relationship-semantics.test.js` usa únicamente fixtures sintéticas. Cubre relación directa, dirección preservada, simetría explícita y ausencia de transitividad; relaciones históricas/futuras/desconocidas; evidencia y referencias inválidas; endpoints y predicados no soportados; duplicados; orden estable; rechazo de `asOf` distintos y scope labels mezclados; avisos limitados al subgrafo consultado; rechazo de ejecución; y ausencia de mutación o exposición de valores.

Estas pruebas verifican funciones puras y contratos de entrada/salida. No prueban autenticación, autorización, aislamiento real de particiones, acceso al repositorio, privacidad en producción ni durabilidad. Schema v5 sigue siendo la fuente del modelo persistente. D.3 conserva la responsabilidad de diseñar contradicciones complejas; D.2 solo marca duplicados detectables y rechaza estados estructuralmente incompatibles.
