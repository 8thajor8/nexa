export interface MockConversationMessage {
  id: string;
  speaker: "Nexa" | "Tú";
  time: string;
  text: string;
}

export const mockConversation: MockConversationMessage[] = [
  {
    id: "welcome",
    speaker: "Nexa",
    time: "10:42",
    text: "Este espacio está preparado para conversaciones. La integración del asistente aún no está activa.",
  },
  {
    id: "question",
    speaker: "Tú",
    time: "10:43",
    text: "¿Puedo probar el aspecto del Command Center aquí?",
  },
  {
    id: "reply",
    speaker: "Nexa",
    time: "10:43",
    text: "Sí. Estos mensajes son ejemplos visuales; no se han enviado a un modelo ni se han guardado.",
  },
];
