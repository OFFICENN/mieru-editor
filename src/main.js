import { Compartment, EditorState, Prec } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { highlightSelectionMatches, openSearchPanel, search, searchKeymap } from "@codemirror/search";

import { EOL_NAMES, countEols, detectLineSeparator, visibleMarks } from "./visibleMarks.js";
import { ENCODINGS, decodeBytes, encodeText, findUnencodable, pickAndReadFile, readFileObject, readHandle, saveAs, writeToHandle } from "./fileio.js";
import { openReplaceListDialog, runRules } from "./replaceList.js";

const APP_NAME = "みえるエディタ";
const SEP_BY_NAME = { CRLF: "\r\n", LF: "\n", CR: "\r" };

// 検索・置換パネルの日本語表示
const JA_PHRASES = {
  Find: "検索",
  Replace: "置換",
  next: "次へ",
  previous: "前へ",
  all: "すべて選択",
  "match case": "大文字小文字を区別",
  "by word": "単語単位",
  regexp: "正規表現",
  replace: "置換",
  "replace all": "すべて置換",
  close: "閉じる",
  "current match": "現在の一致",
  "on line": "行目",
  "replaced match on line $": "$ 行目を置換しました",
  "replaced $ matches": "$ 件置換しました",
  "Go to line": "指定行へ移動",
  go: "移動",
};

// ---- 設定(表示の好み)の保存 ----
const PREF_KEY = "mieru-editor.prefs";
const prefs = (() => {
  try {
    return { showMarks: true, wrap: false, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") };
  } catch {
    return { showMarks: true, wrap: false };
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
};

// ---- 文書の状態 ----
const doc = {
  name: "無題.txt",
  handle: null,
  encoding: "UTF-8",
  dirty: false,
};

const marksComp = new Compartment();
const wrapComp = new Compartment();

function makeState(text, sep) {
  return EditorState.create({
    doc: text,
    extensions: [
      EditorState.lineSeparator.of(sep),
      Prec.high(keymap.of(appKeymap)),
      lineNumbers(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      EditorState.tabSize.of(4),
      EditorState.phrases.of(JA_PHRASES),
      marksComp.of(prefs.showMarks ? visibleMarks() : []),
      wrapComp.of(prefs.wrap ? EditorView.lineWrapping : []),
      EditorView.updateListener.of(onUpdate),
      EditorView.domEventHandlers({ drop: onDrop }),
    ],
  });
}

const appKeymap = [
  { key: "Mod-o", run: () => (openFile(), true) },
  { key: "Mod-s", run: () => (saveFile(false), true) },
  { key: "Mod-Shift-s", run: () => (saveFile(true), true) },
  { key: "Alt-n", run: () => (newFile(), true) },
  { key: "Mod-h", run: openSearchPanel },
  { key: "Mod-Shift-h", run: () => (openReplaceList(), true) },
];

const view = new EditorView({
  parent: document.getElementById("editor"),
  state: makeState("", "\r\n"),
});

// ---- 画面の更新 ----
const $ = (id) => document.getElementById(id);
const encSelect = $("st-enc");
for (const enc of ENCODINGS) encSelect.add(new Option(enc, enc));

let statsTimer = 0;
function onUpdate(update) {
  if (update.docChanged) {
    if (!doc.dirty) {
      doc.dirty = true;
      updateTitle();
    }
    clearTimeout(statsTimer);
    statsTimer = setTimeout(updateStats, 150);
  }
  if (update.selectionSet || update.docChanged) updateCursor(update.state);
}

function updateTitle() {
  const mark = doc.dirty ? "● " : "";
  document.title = `${mark}${doc.name} - ${APP_NAME}`;
  $("file-name").textContent = `${mark}${doc.name}`;
}

function updateCursor(state) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const selLen = state.selection.ranges.reduce((n, r) => n + (r.to - r.from), 0);
  $("st-pos").textContent = `${line.number} 行, ${head - line.from + 1} 列` + (selLen ? ` (${selLen} 文字選択)` : "");
}

/** 行の中に残っている「別の種類の改行」(行内改行)を数える */
function countInlineEols(state) {
  let n = 0;
  for (const line of state.doc.iterLines()) {
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 10 || c === 13) n++;
    }
  }
  return n;
}

function updateStats() {
  const state = view.state;
  const sep = state.lineBreak;
  const chars = state.doc.length - (state.doc.lines - 1);
  $("st-chars").textContent = `${chars.toLocaleString()} 文字 / ${state.doc.lines.toLocaleString()} 行`;
  $("st-eol").value = EOL_NAMES[sep];
  const inline = countInlineEols(state);
  const warn = $("st-eol-warn");
  warn.hidden = inline === 0;
  warn.textContent = `行内改行 ${inline} 箇所`;
  warn.title = "クリックすると次の行内改行へ移動します";
  $("st-enc").value = doc.encoding;
}

$("st-eol-warn").addEventListener("click", () => {
  // カーソルの後ろにある次の行内改行へ移動(最後まで行ったら先頭から)
  // エディタ内の位置では、行の区切りは CRLF でも 1 文字として数えられるので、行ごとに探す
  const state = view.state;
  const docText = state.doc;
  const findFrom = (start) => {
    for (let n = docText.lineAt(start).number; n <= docText.lines; n++) {
      const line = docText.line(n);
      const from = Math.max(start, line.from) - line.from;
      const i = line.text.slice(from).search(/[\r\n]/);
      if (i >= 0) return line.from + from + i;
    }
    return -1;
  };
  let pos = findFrom(state.selection.main.to);
  if (pos < 0) pos = findFrom(0);
  if (pos >= 0) {
    view.dispatch({ selection: { anchor: pos, head: pos + 1 }, scrollIntoView: true });
    view.focus();
  }
});

// ---- ファイル操作 ----
function loadText(text, name, handle, encoding) {
  view.setState(makeState(text, detectLineSeparator(text)));
  doc.name = name;
  doc.handle = handle;
  doc.encoding = encoding;
  doc.dirty = false;
  updateTitle();
  updateStats();
  updateCursor(view.state);
  view.focus();
}

function confirmDiscard() {
  return !doc.dirty || confirm("変更が保存されていません。破棄してよろしいですか?");
}

function newFile() {
  if (!confirmDiscard()) return;
  loadText("", "無題.txt", null, "UTF-8");
}

async function openLoaded(loaded) {
  if (!loaded) return;
  const { text, encoding } = decodeBytes(loaded.bytes);
  loadText(text, loaded.name, loaded.handle, encoding);
}

async function openFile() {
  if (!confirmDiscard()) return;
  try {
    await openLoaded(await pickAndReadFile());
  } catch (e) {
    alert(`ファイルを開けませんでした。\n${e.message}`);
  }
}

function onDrop(event) {
  const file = event.dataTransfer?.files?.[0];
  if (!file) return false;
  event.preventDefault();
  if (!confirmDiscard()) return true;
  const item = event.dataTransfer.items?.[0];
  (async () => {
    // Chrome / Edge ではドロップしたファイルにも上書き保存できるようにする
    const handle = item?.getAsFileSystemHandle ? await item.getAsFileSystemHandle().catch(() => null) : null;
    await openLoaded(handle?.kind === "file" ? await readHandle(handle) : await readFileObject(file));
  })().catch((e) => alert(`ファイルを開けませんでした。\n${e.message}`));
  return true;
}

async function saveFile(forceSaveAs) {
  const text = view.state.sliceDoc(); // 改行は元のまま(行内改行も含む)
  const bad = findUnencodable(text, doc.encoding);
  if (bad.length && !confirm(`${doc.encoding} で表せない文字があります: ${bad.join(" ")}\nこのまま保存すると「?」などに置き換わります。保存しますか?`)) {
    return;
  }
  const bytes = encodeText(text, doc.encoding);
  try {
    let handle = doc.handle;
    if (handle && !forceSaveAs) {
      await writeToHandle(handle, bytes);
    } else {
      handle = await saveAs(doc.name, bytes);
      if (handle === null && "showSaveFilePicker" in window) return; // キャンセル
      if (handle) {
        doc.handle = handle;
        doc.name = handle.name;
      }
    }
    doc.dirty = false;
    updateTitle();
  } catch (e) {
    alert(`保存できませんでした。\n${e.message}`);
  }
}

// ---- 置換リスト ----
function openReplaceList() {
  const sel = view.state.selection.main;
  openReplaceListDialog({
    hasSelection: !sel.empty,
    onRun(rules, options, dryRun) {
      const state = view.state;
      const range = options.selectionOnly && !state.selection.main.empty ? state.selection.main : { from: 0, to: state.doc.length };
      const before = state.sliceDoc(range.from, range.to);
      const res = runRules(before, rules, options, state.lineBreak);
      if (!dryRun && res.text !== before) {
        // 1つの変更としてまとめて反映 → 「元に戻す」1回で全部取り消せる
        const insert = state.toText(res.text); // 文書と同じ改行コードで行に分ける(行内改行は行の中に残る)
        view.dispatch({
          changes: { from: range.from, to: range.to, insert },
          selection: options.selectionOnly ? { anchor: range.from, head: range.from + insert.length } : undefined,
          userEvent: "input.replace.list",
          scrollIntoView: true,
        });
      }
      return res;
    },
  });
}

// ---- 改行コード・文字コードの変更 ----
$("st-eol").addEventListener("change", (e) => {
  const sep = SEP_BY_NAME[e.target.value];
  const text = view.state.sliceDoc();
  const counts = countEols(text);
  const total = counts.crlf + counts.lf + counts.cr;
  if (
    !confirm(
      `ファイル内の改行 ${total} 箇所をすべて ${e.target.value} に統一します。\n行内改行も通常の改行になります。この操作は「元に戻す」で取り消せません。よろしいですか?`
    )
  ) {
    updateStats();
    return;
  }
  const head = view.state.selection.main.head;
  view.setState(makeState(text.replace(/\r\n|\r|\n/g, sep), sep));
  view.dispatch({ selection: { anchor: Math.min(head, view.state.doc.length) } });
  doc.dirty = true;
  updateTitle();
  updateStats();
});

encSelect.addEventListener("change", () => {
  doc.encoding = encSelect.value;
  doc.dirty = true;
  updateTitle();
});

// ---- ツールバー ----
$("btn-new").addEventListener("click", newFile);
$("btn-open").addEventListener("click", openFile);
$("btn-save").addEventListener("click", () => saveFile(false));
$("btn-saveas").addEventListener("click", () => saveFile(true));
$("btn-search").addEventListener("click", () => openSearchPanel(view));
$("btn-replace-list").addEventListener("click", openReplaceList);

const chkMarks = $("chk-marks");
const chkWrap = $("chk-wrap");
chkMarks.checked = prefs.showMarks;
chkWrap.checked = prefs.wrap;
chkMarks.addEventListener("change", () => {
  prefs.showMarks = chkMarks.checked;
  savePrefs();
  view.dispatch({ effects: marksComp.reconfigure(prefs.showMarks ? visibleMarks() : []) });
  view.focus();
});
chkWrap.addEventListener("change", () => {
  prefs.wrap = chkWrap.checked;
  savePrefs();
  view.dispatch({ effects: wrapComp.reconfigure(prefs.wrap ? EditorView.lineWrapping : []) });
  view.focus();
});

// ページ全体へのドロップも受け付ける
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  if (!e.defaultPrevented) onDrop(e);
});

window.addEventListener("beforeunload", (e) => {
  if (doc.dirty) e.preventDefault();
});

// インストールした PWA で、エクスプローラーから開いたファイルを受け取る
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    const handle = params.files?.[0];
    if (handle) await openLoaded(await readHandle(handle));
  });
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

loadText("", "無題.txt", null, "UTF-8");

// 動作確認用(開発時のみ): コンソールから文書を流し込めるようにする
if (import.meta.env.DEV) {
  window.__editor = { view, loadText, decodeBytes, encodeText };
}
