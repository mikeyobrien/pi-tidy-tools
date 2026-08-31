// pi-tidy-bots mini markdown: escape-first, no raw HTML passthrough (XSS-safe by construction).
// Subset: inline code, fenced code, bold, italic, links (https only), - lists, ## headings.
"use strict";
(function (global) {
  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  // Inline subset shared by bubbles and pills. Images are bubble-only —
  // handoff pills get links at most.
  function inlineCore(text, allowImages) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    if (allowImages) {
      // Images before links (same ! prefix): https-only, escaped alt, no other
      // attributes — escape-first already ran, so nothing raw can pass through.
      out = out.replace(
        /!\[([^\]]*)\]\((https:[^)\s]+)\)/g,
        '<img src="$2" alt="$1" loading="lazy" />'
      );
    }
    out = out.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return out;
  }
  function inline(text) {
    return inlineCore(text, true);
  }
  function renderInline(text) {
    return inlineCore(String(text), false);
  }
  function splitCells(row) {
    return row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  const isTableLine = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isSeparatorRow = (line) =>
    /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line);

  // Issue 44: markdown tables — header row + separator row (`|---|:--:|`),
  // alignment from the colons, cells through inline() (escape-first holds).
  function renderTable(headerRow, separatorRowLine, bodyRows) {
    const aligns = splitCells(separatorRowLine).map((cell) => {
      const align =
        cell.startsWith(":") && cell.endsWith(":")
          ? "center"
          : cell.endsWith(":")
            ? "right"
            : "left";
      return ` style="text-align:${align}"`;
    });
    const head = `<tr>${splitCells(headerRow)
      .map((cell, i) => `<th${aligns[i] ?? ""}>${inline(cell)}</th>`)
      .join("")}</tr>`;
    const body = bodyRows
      .map(
        (row) =>
          `<tr>${splitCells(row)
            .map((cell, i) => `<td${aligns[i] ?? ""}>${inline(cell)}</td>`)
            .join("")}</tr>`
      )
      .join("");
    return `<table>${head}${body}</table>`;
  }

  function render(text) {
    const lines = String(text).split("\n");
    const html = [];
    let inCode = false;
    let codeLines = [];
    let listLines = null;
    const flushList = () => {
      if (listLines) {
        html.push(
          "<ul>" +
            listLines.map((item) => "<li>" + inline(item) + "</li>").join("") +
            "</ul>"
        );
        listLines = null;
      }
    };
    const flushCode = () => {
      if (inCode) {
        html.push("<pre>" + escapeHtml(codeLines.join("\n")) + "</pre>");
        codeLines = [];
      }
    };
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const fence = line.match(/^```\s*\w*$/);
      if (fence) {
        flushList();
        if (inCode) {
          flushCode();
          inCode = false;
        } else {
          inCode = true;
        }
        continue;
      }
      if (inCode) {
        codeLines.push(line);
        continue;
      }
      const listItem = line.match(/^\s*[-*]\s+(.*)$/);
      if (listItem) {
        if (!listLines) listLines = [];
        listLines.push(listItem[1]);
        continue;
      }
      flushList();
      // Issue 44: table = header row + separator row (`|---|:--:|`). Malformed
      // (no separator) falls through as plain text — never half-rendered.
      if (
        isTableLine(line) &&
        li + 1 < lines.length &&
        isSeparatorRow(lines[li + 1]) &&
        !inCode
      ) {
        const bodyRows = [];
        let cursor = li + 2;
        while (cursor < lines.length && isTableLine(lines[cursor])) {
          bodyRows.push(lines[cursor]);
          cursor++;
        }
        flushList();
        html.push(renderTable(line, lines[li + 1], bodyRows));
        li = cursor - 1;
        continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.*)$/);
      if (heading) {
        html.push("<strong>" + inline(heading[2]) + "</strong>");
        continue;
      }
      html.push(inline(line));
    }
    flushList();
    flushCode();
    return html.join("\n");
  }
  const PiMd = { render, renderInline, escapeHtml };
  global.PiMd = PiMd;
  if (typeof module !== "undefined" && module.exports) module.exports = PiMd;
})(typeof window !== "undefined" ? window : globalThis);
