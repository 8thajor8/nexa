import { describe, expect, it } from "vitest";
import { welcomeGreeting } from "../src/renderer/conversation-welcome";

describe("conversation welcome", () => {
  it.each([[8, "Buen día"], [14, "Buenas tardes"], [22, "Buenas noches"]])(
    "uses the local-time greeting for hour %i", (hour, prefix) => {
      const date = new Date(2026, 9, 15, Number(hour), 0, 0);
      expect(welcomeGreeting(date)).toBe(`${prefix}, Jor. ¿Qué hacemos hoy?`);
    },
  );
});
