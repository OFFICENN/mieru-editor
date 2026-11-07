// 改行・タブ・空白などを「見える」ようにする拡張機能
//
// 方針:
//  - ファイルで一番多い改行コード(CRLF / LF / CR)を行の区切りにする(EditorState.lineSeparator)。
//  - それ以外の改行文字(例: CRLF ファイル内の LF = Excel のセル内改行)は行を分けず、
//    行の中の文字として残し、赤い記号で表示する。保存時は元のバイト列どおりに戻る。
//  - 行末には区切りの改行記号、文書の末尾には [EOF] を表示する。

import { Decoration, EditorView, ViewPlugin, WidgetType, highlightSpecialChars, highlightWhitespace } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

export const EOL_NAMES = { "\r\n": "CRLF", "\n": "LF", "\r": "CR" };
const EOL_SYMBOLS = { "\r\n": "↵", "\n": "↓", "\r": "←" };

class EolWidget extends WidgetType {
  constructor(sep) {
    super();
    this.sep = sep;
  }
  eq(other) {
    return other.sep === this.sep;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-eolMark";
    span.textContent = EOL_SYMBOLS[this.sep] ?? "↵";
    span.title = `改行 (${EOL_NAMES[this.sep] ?? "?"})`;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class EofWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-eofMark";
    span.textContent = "[EOF]";
    return span;
  }
}

const eofWidget = Decoration.widget({ widget: new EofWidget(), side: 1 });

function buildEolDecorations(view) {
  const sep = view.state.lineBreak;
  const eolDeco = Decoration.widget({ widget: new EolWidget(sep), side: 1 });
  const builder = new RangeSetBuilder();
  const doc = view.state.doc;
  let lastLine = 0;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (line.number > lastLine) {
        builder.add(line.to, line.to, line.number < doc.lines ? eolDeco : eofWidget);
        lastLine = line.number;
      }
      if (line.to + 1 > to) break;
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const eolMarksPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildEolDecorations(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged || update.startState.lineBreak !== update.state.lineBreak) {
        this.decorations = buildEolDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// 行の中に残った改行文字・全角空白の表示
function renderSpecial(code) {
  const span = document.createElement("span");
  if (code === 10 || code === 13) {
    span.className = "cm-inlineEol";
    span.textContent = code === 10 ? "↓LF" : "←CR";
    span.title =
      code === 10
        ? "行内改行 (LF)。ファイル全体の改行コードと違う改行です(Excel のセル内改行など)"
        : "行内改行 (CR)。ファイル全体の改行コードと違う改行です";
    return span;
  }
  if (code === 0x3000) {
    span.className = "cm-zenSpace";
    span.textContent = "　";
    span.title = "全角空白";
    return span;
  }
  return null; // それ以外の制御文字は CodeMirror 標準の表示
}

export function visibleMarks() {
  return [
    highlightWhitespace(), // 半角空白(・)とタブ(→)
    highlightSpecialChars({ render: renderSpecial, addSpecialChars: /　/ }),
    eolMarksPlugin,
    EditorView.baseTheme({
      ".cm-eolMark": { color: "var(--mark-eol)", padding: "0 1px", userSelect: "none" },
      ".cm-eofMark": { color: "var(--mark-eof)", fontSize: "85%", paddingLeft: "2px", userSelect: "none" },
      ".cm-inlineEol": {
        color: "#fff",
        backgroundColor: "var(--mark-inline-eol)",
        borderRadius: "3px",
        padding: "0 2px",
        margin: "0 1px",
        fontSize: "80%",
        fontWeight: "bold",
      },
      ".cm-zenSpace": { outline: "1px dashed var(--mark-zen)", outlineOffset: "-2px" },
      ".cm-highlightSpace": { backgroundImage: "radial-gradient(circle at 50% 55%, var(--mark-space) 15%, transparent 5%)" },
      ".cm-highlightTab": { opacity: "1" },
    }),
  ];
}

// 改行コードの種類を数える
export function countEols(text) {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  return { crlf, lf, cr };
}

// 一番多い改行コード(なければ Windows 標準の CRLF)
export function detectLineSeparator(text) {
  const { crlf, lf, cr } = countEols(text);
  if (crlf === 0 && lf === 0 && cr === 0) return "\r\n";
  if (crlf >= lf && crlf >= cr) return "\r\n";
  if (lf >= cr) return "\n";
  return "\r";
}
