// logo.mjs — піксельне лого для CLI, малюється напівблоками ▀ ▄ █
//
//   node logo.mjs                               показати лого в терміналі
//   import { renderLogo } from "./logo.mjs"     отримати рядок з ANSI-кодами для свого CLI

import { pathToFileURL } from "node:url";

// Сітка 17×17: W — тіло, E — очі, S — тінь, "." — порожньо.
// Порожні клітинки не фарбують фон, тож лого лягає на будь-який фон терміналу.
const GRID = [
  "........WW.......",
  "......WWWWWW.....",
  "...WWWWWWWWWWWW..",
  "..SWWWWWWWWEEWW..",
  "..SWWWEEWWEEEEW..",
  "..WWWEEEEWEEEEWW.",
  ".SWWWEEEEWEEEEWW.",
  ".WWWWEEEEWWEEWWWW",
  "SWWWWWEEWWWWWWWWW",
  "SSWWWWWWWWWWWWWW.",
  ".SWWWWWWWWWWWWWW.",
  ".SSWWWWWWWWWWWW..",
  "..SWWWWWWWWWWWW..",
  "..SWWWWWWWWWWWW..",
  "..SSSSWWWWWWSS...",
  ".....SSSWWS......",
  ".......SS........",
];

const PALETTE = {
  W: [255, 255, 255], // тіло
  E: [43, 43, 43], // очі
  S: [74, 74, 74], // тінь
};

// Запасні кольори xterm-256 для терміналів без truecolor
const PALETTE_256 = { W: 231, E: 235, S: 239 };

const ESC = "\x1b[";
const RESET = `${ESC}0m`;

const hasTrueColor = (env = process.env) =>
  /truecolor|24bit/i.test(env.COLORTERM ?? "") || Boolean(env.WT_SESSION);

// Повертає лого 17×9 символів з ANSI-кодами (рядки розділені \n).
export function renderLogo({ trueColor = hasTrueColor() } = {}) {
  const color = (code, key) =>
    trueColor
      ? `${ESC}${code};2;${PALETTE[key].join(";")}m`
      : `${ESC}${code};5;${PALETTE_256[key]}m`;
  const fg = (key) => color(38, key);
  const bg = (key) => color(48, key);

  const width = GRID[0].length;
  const rows = GRID.length % 2 ? [...GRID, ".".repeat(width)] : GRID;

  const lines = [];
  for (let y = 0; y < rows.length; y += 2) {
    let line = "";
    let style = "";
    const put = (next, ch) => {
      if (next !== style) {
        line += RESET + next;
        style = next;
      }
      line += ch;
    };

    // один символ = два пікселі по вертикалі: верхній у fg ("▀"), нижній у bg
    for (let x = 0; x < width; x++) {
      const top = rows[y][x];
      const bottom = rows[y + 1][x];
      if (top === "." && bottom === ".") put("", " ");
      else if (bottom === ".") put(fg(top), "▀");
      else if (top === ".") put(fg(bottom), "▄");
      else if (top === bottom) put(fg(top), "█");
      else put(fg(top) + bg(bottom), "▀");
    }
    lines.push(style ? line + RESET : line);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(renderLogo());
}
