// Small decoder for the cursor-positioned frames our native TUI emits in tests.
// ANSI styling alone cannot be stripped to assert a diff-rendered screen.
export function terminalScreen(raw: string, width = 80, height = 24): string {
  let rows = Array.from({ length: height }, () => Array(width).fill(" "));
  let row = 0, col = 0;
  const tokens = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[([0-?]*)([ -/]*)([@-~])|([^\x1b]+)/g;
  for (const token of raw.matchAll(tokens)) {
    if (token[3]) {
      const args = token[1].split(";").map(v => Number(v) || 0);
      if (token[3] === "H" || token[3] === "f") { row = Math.max(0, (args[0] || 1) - 1); col = Math.max(0, (args[1] || 1) - 1); }
      if (token[3] === "J" && args[0] === 2) rows = Array.from({ length: height }, () => Array(width).fill(" "));
      if (token[3] === "K" && row < height) {
        if (args[0] === 2) rows[row].fill(" "); else rows[row].fill(" ", col);
      }
      if (token[3] === "A") row = Math.max(0, row - (args[0] || 1));
      if (token[3] === "B") row += args[0] || 1;
      if (token[3] === "C") col += args[0] || 1;
      if (token[3] === "D") col = Math.max(0, col - (args[0] || 1));
    } else if (token[4]) for (const char of token[4]) {
      if (char === "\r") { col = 0; continue; }
      if (char === "\n") { row++; continue; }
      if (char === "\b") { col = Math.max(0, col - 1); continue; }
      if (char.charCodeAt(0) < 32) continue;
      if (row < height && col < width) rows[row][col] = char;
      col++;
    }
  }
  return rows.map(line => line.join("")).join("\n");
}
