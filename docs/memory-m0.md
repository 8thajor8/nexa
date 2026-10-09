# Memory M.0 — Retiro reversible de escrituras heredadas

## Alcance

M.0 desactiva las herramientas heredadas `remember` y `forget` de Memory1 en dos puntos: ya no se ofrecen al modelo y el dispatcher las rechaza aunque un llamador las invoque directamente. La respuesta indica que la escritura está deshabilitada y no afirma que se haya cambiado ningún recuerdo. Las definiciones registradas se conservan para facilitar una reversión controlada del código.

`recall`, la carga de contexto de Memory1 y las demás herramientas mantienen su comportamiento. El backend predeterminado y efectivo no cambia. Memory2 sigue inactiva y Automatic Memory continúa deshabilitada.

## Datos existentes

Al implementar M.0, `data/memory.json` era JSON válido con dos entradas. El archivo no se modificó ni se migró; su SHA-256 esperado permaneció sin cambios. No se incluyen sus valores en este documento.

## Límites

Este bloqueo cubre el dispatcher de herramientas utilizado por el agente. No elimina Memory1, no borra sus datos, no impide que otro código importe y llame directamente a una función interna de registro, y no activa una ruta de escritura de Memory2. La reversión requiere una modificación revisada del código; no hay interruptor de entorno que vuelva a habilitar estas escrituras accidentalmente.
