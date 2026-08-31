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
  function inline(text) {
    let out = escapeHtml(text);
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
    out = out.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
    return out;
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
    for (const line of lines) {
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
  const PiMd = { render, escapeHtml };
  global.PiMd = PiMd;
  if (typeof module !== "undefined" && module.exports) module.exports = PiMd;
})(typeof window !== "undefined" ? window : globalThis);
