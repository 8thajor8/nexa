import {
    findUiElement,
    focusUiElement,
    getUiValue,
    inspectUi,
    invokeUiElement,
    setUiValue,
} from './elements.js';

function functionTool(name, description, properties) {
    return {
        type: 'function',
        name,
        description,
        parameters: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
        },
        strict: true,
    };
}

const appProperty = { type: 'string', minLength: 1, maxLength: 120, description: 'Nombre de una aplicación abierta, por ejemplo Chrome o Notepad.' };
const refProperty = { type: 'string', pattern: '^ui_[0-9]+$', description: 'Referencia efímera ui_* devuelta por inspect_ui o find_ui_element.' };

export const inspectUiTool = functionTool('inspect_ui',
    'Inspecciona un número limitado de controles accesibles dentro de la ventana de una aplicación abierta.', {
        app: appProperty,
        maxDepth: { type: 'integer', minimum: 1, maximum: 6, description: 'Profundidad máxima (usar 4 normalmente).' },
        maxElements: { type: 'integer', minimum: 1, maximum: 150, description: 'Máximo de controles (usar 80 normalmente).' },
        maxTextLength: { type: 'integer', minimum: 20, maximum: 300, description: 'Máximo de caracteres de nombre (usar 160 normalmente).' },
    });
export const findUiElementTool = functionTool('find_ui_element',
    'Resuelve en una sola consulta un control accesible por criterios determinísticos y devuelve una referencia ui_* lista para usar. No hace falta llamar antes a inspect_ui cuando ya sabés qué control buscás. Dejá vacíos los criterios que no uses; si hay ambigüedad, agregá criterios.', {
        app: appProperty,
        name: { type: 'string', maxLength: 160, description: 'Nombre total o parcial; cadena vacía para omitir.' },
        controlType: { type: 'string', maxLength: 80, description: 'Tipo como Button, Edit o ListItem; cadena vacía para omitir.' },
        automationId: { type: 'string', maxLength: 160, description: 'AutomationId exacto; cadena vacía para omitir.' },
    });
export const focusUiElementTool = functionTool('focus_ui_element', 'Enfoca un control accesible previamente resuelto. Usalo solo si el usuario pidió enfocar el control; no es necesario antes de invoke_ui_element o set_ui_value.', { ref: refProperty });
export const invokeUiElementTool = functionTool('invoke_ui_element', 'Invoca directamente el patrón UI Automation Invoke de un control resuelto; no necesita focus_ui_element antes. Si devuelve success:true, la acción está completada: no la repitas ni la verifiques salvo que el usuario lo pida. La acción puede tener efectos y debe corresponder al pedido explícito del usuario.', { ref: refProperty });
export const setUiValueTool = functionTool('set_ui_value', 'Establece texto solo si el control admite ValuePattern. Si devuelve success:true, la escritura está completada: no la repitas ni la verifiques salvo que el usuario lo pida. TextPattern permite leer, pero no modificar; este control no envía formularios ni mensajes.', {
    ref: refProperty,
    value: { type: 'string', maxLength: 2000, description: 'Texto para el control accesible.' },
});
export const getUiValueTool = functionTool('get_ui_value', 'Lee el valor accesible de un control y limita la respuesta a 1000 caracteres.', { ref: refProperty });

export const uiAutomationRegistrations = [
    { definition: inspectUiTool, execute: inspectUi },
    { definition: findUiElementTool, execute: findUiElement },
    { definition: focusUiElementTool, execute: focusUiElement },
    { definition: invokeUiElementTool, execute: invokeUiElement },
    { definition: setUiValueTool, execute: setUiValue },
    { definition: getUiValueTool, execute: getUiValue },
];
