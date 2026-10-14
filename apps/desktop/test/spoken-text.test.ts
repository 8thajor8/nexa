import { describe, expect, it } from "vitest";
import { prepareSpokenText } from "../src/main/spoken-text";

describe("speech-only link wording", () => {
  it("speaks Markdown labels and keeps surrounding prose", () => {
    const visible = "Abrí [la guía de Nexa](https://example.com/docs?q=1) cuando puedas.";
    expect(prepareSpokenText(visible)).toBe("Abrí la guía de Nexa cuando puedas.");
    expect(visible).toContain("https://example.com/docs?q=1");
  });

  it("replaces several bare destinations while preserving punctuation", () => {
    expect(prepareSpokenText("Mirá https://example.com/a?x=1, y www.example.org/b#parte."))
      .toBe("Mirá este sitio web, y este sitio web.");
  });

  it("does not change ordinary text or local paths", () => {
    expect(prepareSpokenText("Usá C:\\Nexa\\archivo.txt y luego continuá.")).toBe("Usá C:\\Nexa\\archivo.txt y luego continuá.");
    expect(prepareSpokenText("Una respuesta sin enlaces.")).toBe("Una respuesta sin enlaces.");
  });
});
