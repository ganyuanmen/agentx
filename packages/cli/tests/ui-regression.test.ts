import { describe, expect, it } from "vitest";
import { Ui } from "../src/ui.js";

describe("regression: answer line survives a mascot banner", () => {
  it("writes the assistant line after a sidebar panel in tui mode", () => {
    let text = "";
    const ui = new Ui(
      {
        stdout: { write: (c: string) => { text += c; return true; }, isTTY: true, columns: 100 },
        stderr: { write: () => true, isTTY: true },
        env: {},
      },
      { forceMode: "tui" },
    );

    text += ui.logo();
    text += ui.sidebarPanel("agentx", [{ label: "file", items: ["read_file"] }]);
    text += `${ui.assistantLine("我是 agentx。")}\n`;

    expect(text).toContain("我是 agentx。");
    expect(text).toContain("⏺");
  });

  it("keeps the answer when the model text starts with newlines", () => {
    const ui = new Ui(
      {
        stdout: { write: () => true, isTTY: true, columns: 100 },
        stderr: { write: () => true, isTTY: true },
        env: {},
      },
      { forceMode: "tui" },
    );
    const rendered = ui.assistantLine("\n\n我是 agentx。");
    expect(rendered).toContain("我是 agentx。");
  });
});
