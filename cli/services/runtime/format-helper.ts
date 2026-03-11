function stripAnsiCodes(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

export function boxifyMessage(lines: string[]): string {
  if (lines.length === 0) {
    return "";
  }

  const longestLineLength = Math.max(
    ...lines.map((line) => stripAnsiCodes(line).length)
  );
  const contentWidth = longestLineLength;
  const boxWidth = contentWidth + 6;

  const formatLine = (content: string): string => {
    const visibleLength = stripAnsiCodes(content).length;
    const padding = " ".repeat(contentWidth - visibleLength);
    return `│  ${content}${padding}  │`;
  };

  const horizontalBar = "─".repeat(boxWidth - 2);
  const topBorder = `┌${horizontalBar}┐`;
  const bottomBorder = `└${horizontalBar}┘`;

  const formattedLines = lines.map(formatLine).join("\n");

  return `\n${topBorder}\n${formattedLines}\n${bottomBorder}\n`;
}
