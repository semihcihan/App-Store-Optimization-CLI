import { jest } from "@jest/globals";
import { boxifyMessage } from "./format-helper";

describe("format-helper", () => {
  describe("boxifyMessage", () => {
    it("should return empty string for empty array", () => {
      const result = boxifyMessage([]);
      expect(result).toBe("");
    });

    it("should create a box for a single line", () => {
      const result = boxifyMessage(["Hello"]);
      expect(result).toContain("┌");
      expect(result).toContain("┐");
      expect(result).toContain("│");
      expect(result).toContain("└");
      expect(result).toContain("┘");
      expect(result).toContain("Hello");
    });

    it("should create a box for multiple lines", () => {
      const result = boxifyMessage(["Line 1", "Line 2", "Line 3"]);
      expect(result).toContain("Line 1");
      expect(result).toContain("Line 2");
      expect(result).toContain("Line 3");
    });

    it("should size box based on longest line", () => {
      const result = boxifyMessage(["Short", "This is a much longer line"]);
      const lines = result.split("\n");
      const topBorder = lines[1];
      const bottomBorder = lines[lines.length - 2];

      expect(topBorder.length).toBe(bottomBorder.length);
      expect(topBorder.length).toBeGreaterThan(30);
    });

    it("should handle ANSI color codes correctly", () => {
      const green = "\x1b[32m";
      const reset = "\x1b[0m";
      const result = boxifyMessage([
        `${green}Colored text${reset}`,
        "Normal text",
      ]);

      expect(result).toContain("Colored text");
      expect(result).toContain("Normal text");
      expect(result).toContain(green);
      expect(result).toContain(reset);

      const lines = result.split("\n");
      const topBorder = lines[1];
      const bottomBorder = lines[lines.length - 2];
      expect(topBorder.length).toBe(bottomBorder.length);
    });

    it("should pad shorter lines to match longest line", () => {
      const result = boxifyMessage(["Short", "Much longer line here"]);
      const lines = result.split("\n");
      const contentLine1 = lines[2];
      const contentLine2 = lines[3];

      const visibleLength1 = contentLine1.replace(/\x1b\[[0-9;]*m/g, "").length;
      const visibleLength2 = contentLine2.replace(/\x1b\[[0-9;]*m/g, "").length;

      expect(visibleLength1).toBe(visibleLength2);
    });

    it("should handle lines with mixed ANSI codes", () => {
      const red = "\x1b[31m";
      const green = "\x1b[32m";
      const reset = "\x1b[0m";
      const result = boxifyMessage([
        `${red}Red${reset} and ${green}Green${reset}`,
        "Plain text",
      ]);

      expect(result).toContain("Red");
      expect(result).toContain("Green");
      expect(result).toContain("Plain text");
    });

    it("should create proper box structure", () => {
      const result = boxifyMessage(["Test"]);
      const lines = result.split("\n").filter((line) => line.length > 0);

      expect(lines[0]).toMatch(/^┌─+┐$/);
      expect(lines[1]).toMatch(/^│  .+  │$/);
      expect(lines[2]).toMatch(/^└─+┘$/);
    });

    it("should handle unicode characters correctly", () => {
      const result = boxifyMessage(["Test → Arrow", "Emoji 🚀"]);
      expect(result).toContain("→");
      expect(result).toContain("🚀");
    });
  });
});
