# Automatic Memory C.5e — Calibración e identidad canónica

## Diagnóstico

La primera respuesta real de C.5d no se conservó en bruto, así que no es posible atribuir con certeza por qué omitió TypeScript. El contrato previo pedía no convertir estados transitorios en recuerdos durables, y el vocabulario distinguía capacidad en idiomas humanos (`user.speaks_language`) pero no actividades de aprendizaje técnico. La omisión es compatible con esas restricciones, aunque no demuestra cuál fue el razonamiento del modelo. C.5e añade una categoría precisa, `learning_activity`, para representar solo una actividad explícita y actual; no la equipara a dominio de la tecnología ni a una meta de largo plazo.

El resultado de React sí llegó al validador con evidencia exacta. La policy lo dejó en `ask` porque el backend activo era Memory1 y no se proporcionó un snapshot canónico de Memory2. La etiqueta textual `user` describe una propuesta del extractor; no demuestra qué persona habla ni identifica `self_person_id`.

## Identidad

La frontera de `stdin` demuestra que el texto provino de una entrada directa de la instancia local, y liga la prueba al turno. No autentica a una persona. El store de Memory2 tiene un `self_person_id`, pero el runtime actual no dispone de un principal humano autenticado ni de una asociación confiable entre ese principal y la entidad Self. C.5e no crea esa asociación, no acepta IDs del extractor o de herramientas y no modifica entidades personales. Sin un snapshot estructural válido, la policy conserva `ask` con `subject_not_canonically_resolved`; un ID escrito en `subject_text` tampoco resuelve Self. Las menciones de terceros siguen requiriendo revisión.

Una asociación futura necesitaría una fuente de identidad confiable fuera del texto conversacional, ligada al turno por el runtime. Hasta que exista y se audite esa fuente, no se debe elevar la etiqueta `user` a identidad canónica.

## Ajustes de calibración

- El contrato pide emitir candidatos separados para hechos independientes y evidencia mínima exacta.
- La categoría `learning_activity` normaliza a `user.learning_activity`. Solo representa un aprendizaje actual expresamente declarado; no equivale a conocer una tecnología, una profesión ni una meta duradera.
- Esa categoría es de revisión exclusivamente. La policy devuelve `ask` incluso con un snapshot sintético que resuelve Self; nunca es candidata a `auto_save`.
- Una meta a largo plazo explícita se representa como `long_term_goal` / `user.long_term_goal` y también requiere revisión; no se infiere de una preferencia o actividad actual.
- Las tecnologías y frameworks no se clasifican como idiomas humanos. El predicado de idioma sigue limitado a capacidades de idiomas naturales.
- Metas sin un tipo permitido, preferencias temporales, hipótesis, citas, datos financieros, información confidencial y hechos sobre terceros conservan sus rechazos o requieren revisión según las reglas existentes. No se relajan los umbrales de confianza ni las reglas de procedencia.

## Batería sintética y métricas reproducibles

Las pruebas inyectan propuestas fijas, sin modelo ni red. En el ejemplo de dos hechos, la fixture entrega exactamente dos candidatos; ambos pasan la validación de estructura y evidencia. Sin snapshot, ambos quedan en `ask`. Con un store Self sintético, la preferencia de React obtiene la disposición determinista de policy `auto_save`, mientras que el aprendizaje de TypeScript permanece `ask`. Este snapshot existe solo dentro del test y no establece identidad real.

En la matriz de nueve candidatos simulados, con un Self sintético: 9/9 evidencias verificadas, 2 disposiciones `auto_save`, 5 `ask` y 2 `ignore`, todas iguales a las expectativas fijadas. También se comprueba el bloqueo previo de preferencias temporales y contenido confidencial, el rechazo de JSON malformado y la distinción entre salida vacía y categoría no compatible. Las cifras miden consistencia del validador/policy frente a fixtures; **no miden precisión, recall ni comportamiento del modelo real**. No hubo llamadas a OpenAI.

## Seguridad y límites

El extractor real sigue desactivado en la CLI. No se cambiaron consentimiento, exclusiones, procedencia ni el bloqueo de sesión tras exposición a contenido externo. Los tests no escriben en repositorios, colas ni memorias. `learning_activity` es únicamente una ampliación del vocabulario de propuesta y una decisión de policy de revisión; no habilita una ruta de escritura.

Memory1 permanece activa; Memory2 no se activa ni se migra. No se usaron datos de herramientas, CRM, correo, calendario o web. La calibración sintética no resuelve la identidad del hablante, no demuestra calidad del extractor real y no sustituye la revisión de retención del proveedor.

## Siguiente paso recomendado

Antes de C.6, diseñar y auditar una fuente de identidad que pueda asociar un principal autenticado con `self_person_id` para el turno exacto. Mantener `ask` mientras falte esa asociación. Para calibrar el extractor, primero acordar etiquetas esperadas para una batería sintética independiente y medir omisiones/falsos positivos con llamadas reales solo bajo autorización separada; los mocks actuales prueban el contrato y la policy, no el modelo.
