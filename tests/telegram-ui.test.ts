import { describe, expect, it } from "vitest";
import { accountKeyboard, mainMenuKeyboard, toolsKeyboard } from "../src/telegram/ui";

describe("Telegram UI keyboards", () => {
  it("keeps the Admin command out of the ordinary menu and exposes new-dialog navigation", () => {
    const regular = JSON.stringify(mainMenuKeyboard(false));
    const admin = JSON.stringify(mainMenuKeyboard(true));
    expect(regular).toContain("menu:chat");
    expect(regular).toContain("dialog:new");
    expect(regular).not.toContain("menu:admin");
    expect(admin).not.toContain("menu:admin");
  });

  it("keeps tools and account navigation actionable", () => {
    expect(JSON.stringify(toolsKeyboard())).toContain("tool:search");
    expect(JSON.stringify(toolsKeyboard())).toContain("tool:documents");
    expect(JSON.stringify(accountKeyboard())).toContain("account:plans");
  });
});
