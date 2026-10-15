export function welcomeGreeting(date: Date): string {
  const hour = date.getHours();
  const greeting = hour < 12 ? "Buen día" : hour < 19 ? "Buenas tardes" : "Buenas noches";
  return `${greeting}, Jor. ¿Qué hacemos hoy?`;
}
