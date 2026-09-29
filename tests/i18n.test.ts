import { describe, expect, it } from "vitest";
import { LANGUAGE_LABELS, normalizeLocale, t } from "../src/i18n";

describe("i18n", () => {
  it("supports all specified locales and falls back to Russian", () => {
    expect(normalizeLocale("ru")).toBe("ru");
    expect(normalizeLocale("en")).toBe("en");
    expect(normalizeLocale("uz")).toBe("uz");
    expect(normalizeLocale("fr")).toBe("fr");
    expect(normalizeLocale("de")).toBe("de");
    expect(normalizeLocale("xx")).toBe("ru");
    expect(t("en", "chat.processing")).toContain("Formulating");
    expect(t("de", "chat.processing")).toContain("Antwort");
    expect(LANGUAGE_LABELS.uz).toBe("O'zbek");
  });
});
