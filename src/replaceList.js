// 置換リスト(一括置換)
//
// 1行に1ルール:  検索文字列 => 置換後文字列   または   検索文字列<TAB>置換後文字列
// # で始まる行と空行は無視。上から順番に置換し、1回の「元に戻す」で全部取り消せる。

const STORAGE_KEY = "mieru-editor.replaceList";

const SAMPLE = [
  "# 置換リスト(一括置換)",
  "# 1行に1ルール:  検索文字列 => 置換後文字列   (区切りはタブでも可)",
  "# # で始まる行は無視されます。上から順番に置換します。",
  "# 例(行頭の # を消すと有効になります):",
  "#　 =>  ",
  "#\\t => ,",
  "#\\n\\n => \\n",
].join("\n");

export const defaultOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  selectionOnly: false,
  escapes: true,
};

export function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      return { list: data.list ?? SAMPLE, options: { ...defaultOptions, ...(data.options ?? {}) } };
    }
  } catch {
    // 保存領域が使えない環境では毎回サンプルから
  }
  return { list: SAMPLE, options: { ...defaultOptions } };
}

export function saveState(list, options) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ list, options }));
  } catch {
    // 保存できなくても動作には影響しない
  }
}

/** リストを解析してルールの配列にする */
export function parseList(text) {
  const rules = [];
  text.split(/\r\n|\r|\n/).forEach((line, i) => {
    if (line === "" || line.startsWith("#")) return;
    const tab = line.indexOf("\t");
    const arrow = line.indexOf(" => ");
    let search;
    let replace;
    if (tab >= 0 && (arrow < 0 || tab < arrow)) {
      search = line.slice(0, tab);
      replace = line.slice(tab + 1);
    } else if (arrow >= 0) {
      search = line.slice(0, arrow);
      replace = line.slice(arrow + 4);
    } else {
      search = line; // 区切りが無い行は「削除」として扱う
      replace = "";
    }
    if (search !== "") rules.push({ lineNo: i + 1, search, replace });
  });
  return rules;
}

/** \t \n \r \\ を実際の文字にする */
export function unescape(s) {
  return s.replace(/\\([tnr\\])/g, (_, c) => ({ t: "\t", n: "\n", r: "\r", "\\": "\\" })[c]);
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");

/** 文字列をそのまま探す正規表現にする。改行はどの改行コードにも一致させる */
function literalToPattern(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\r" || c === "\n") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      out += "(?:\\r\\n|\\r|\\n)";
    } else {
      out += escapeRegExp(c);
    }
  }
  return out;
}

/** 改行を文書の改行コードに揃える */
const normalizeEol = (s, eol) => s.replace(/\r\n|\r|\n/g, eol);

/**
 * ルール1つ分の置換処理を作る。
 * 戻り値: { apply(text) => { text, count } } または { error }
 */
export function compileRule(rule, options, eol) {
  try {
    let pattern;
    let replacer;
    if (options.regex) {
      pattern = rule.search;
      // JavaScript の置換文字列は \n を解釈しないので、ここで実際の改行に直す($1 などはそのまま使える)
      const rep = normalizeEol(unescape(rule.replace), eol);
      replacer = rep;
    } else {
      const search = options.escapes ? unescape(rule.search) : rule.search;
      const rep = normalizeEol(options.escapes ? unescape(rule.replace) : rule.replace, eol);
      pattern = literalToPattern(search);
      replacer = () => rep; // 関数にすると $ などが特別扱いされない
    }
    let flags = "g";
    if (!options.caseSensitive) flags += "i";
    if (options.wholeWord) {
      pattern = `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`;
      flags += "u";
    }
    const re = new RegExp(pattern, flags);
    return {
      apply(text) {
        let count = 0;
        const result = text.replace(re, (...args) => {
          count++;
          if (typeof replacer === "function") return replacer();
          // 正規表現モード: $1 などの参照を展開する
          const match = args[0];
          const groupsObj = typeof args[args.length - 1] === "object" ? args[args.length - 1] : undefined;
          const offsetIndex = groupsObj ? args.length - 3 : args.length - 2;
          const groups = args.slice(1, offsetIndex);
          return expandReplacement(replacer, match, groups, groupsObj);
        });
        return { text: result, count };
      },
    };
  } catch (e) {
    return { error: e.message };
  }
}

function expandReplacement(rep, match, groups, named) {
  return rep.replace(/\$(\$|&|\d{1,2}|<[^>]*>)/g, (all, k) => {
    if (k === "$") return "$";
    if (k === "&") return match;
    if (k.startsWith("<")) return named?.[k.slice(1, -1)] ?? "";
    const n = Number(k);
    return n >= 1 && n <= groups.length ? (groups[n - 1] ?? "") : all;
  });
}

/** すべてのルールを順番に適用する */
export function runRules(text, rules, options, eol) {
  const results = [];
  let current = text;
  let total = 0;
  for (const rule of rules) {
    const compiled = compileRule(rule, options, eol);
    if (compiled.error) {
      results.push({ rule, error: compiled.error, count: 0 });
      continue;
    }
    const r = compiled.apply(current);
    current = r.text;
    total += r.count;
    results.push({ rule, count: r.count });
  }
  return { text: current, total, results };
}

const visible = (s) => {
  const v = s.replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/　/g, "□");
  if (v === "") return "(空)";
  return v.length > 30 ? v.slice(0, 30) + "…" : v;
};

let cleanupPrevious = null;

/** 置換リストのダイアログを開く。実行時に onRun(rules, options, dryRun) が呼ばれ、結果の配列を返す */
export function openReplaceListDialog({ hasSelection, onRun }) {
  const saved = loadSaved();
  const dlg = document.getElementById("replace-list-dialog");
  const textarea = dlg.querySelector("#rl-text");
  const resultBox = dlg.querySelector("#rl-result");
  const opt = {
    regex: dlg.querySelector("#rl-regex"),
    caseSensitive: dlg.querySelector("#rl-case"),
    wholeWord: dlg.querySelector("#rl-word"),
    selectionOnly: dlg.querySelector("#rl-selection"),
    escapes: dlg.querySelector("#rl-escapes"),
  };

  textarea.value = saved.list;
  for (const [k, el] of Object.entries(opt)) el.checked = !!saved.options[k];
  opt.selectionOnly.disabled = !hasSelection;
  if (!hasSelection) opt.selectionOnly.checked = false;
  resultBox.textContent = "";

  const readOptions = () => Object.fromEntries(Object.entries(opt).map(([k, el]) => [k, el.checked && !el.disabled]));
  const persist = () => saveState(textarea.value, { ...readOptions(), selectionOnly: opt.selectionOnly.checked });

  const showResults = (res, dryRun) => {
    if (!res) return;
    const lines = [];
    lines.push(
      dryRun
        ? `【確認のみ】${res.results.length} 個のルールで、合計 ${res.total} 箇所が置換されます(まだ置換していません)。`
        : `${res.results.length} 個のルールで、合計 ${res.total} 箇所を置換しました。「元に戻す」(Ctrl+Z) 1回で全部取り消せます。`
    );
    for (const r of res.results) {
      const head = `${r.rule.lineNo}行目: ${visible(r.rule.search)} → ${visible(r.rule.replace)}`;
      lines.push(r.error ? `${head}  …エラー: ${r.error}` : `${head}  …${r.count}件`);
    }
    resultBox.textContent = lines.join("\n");
  };

  const run = (dryRun) => {
    const rules = parseList(textarea.value);
    if (rules.length === 0) {
      resultBox.textContent = "有効なルールがありません。「検索文字列 => 置換後文字列」の形で1行ずつ入力してください。";
      return;
    }
    persist();
    showResults(onRun(rules, readOptions(), dryRun), dryRun);
  };

  const insert = (s) => {
    const { selectionStart: a, selectionEnd: b, value } = textarea;
    textarea.value = value.slice(0, a) + s + value.slice(b);
    textarea.selectionStart = textarea.selectionEnd = a + s.length;
    textarea.focus();
  };

  const handlers = {
    "rl-preview": () => run(true),
    "rl-run": () => run(false),
    "rl-close": () => dlg.close(),
    "rl-ins-arrow": () => insert(" => "),
    "rl-ins-tab": () => insert("\\t"),
    "rl-ins-lf": () => insert("\\n"),
    "rl-ins-zen": () => insert("　"),
    "rl-load": () => loadListFile(textarea),
    "rl-save": () => saveListFile(textarea.value),
  };
  const onClick = (e) => {
    const id = e.target.closest("button")?.id;
    if (id && handlers[id]) {
      e.preventDefault();
      handlers[id]();
    }
  };
  // テキストエリアで Tab キーを押したら、フォーカス移動ではなくタブ文字を入れる
  const onKeyDown = (e) => {
    if (e.key === "Tab" && e.target === textarea && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      insert("\t");
    }
  };
  // 前回のダイアログのイベント処理が残っていたら必ず外す(二重に実行されないように)
  cleanupPrevious?.();
  const onClose = () => cleanup();
  const cleanup = () => {
    persist();
    dlg.removeEventListener("click", onClick);
    dlg.removeEventListener("keydown", onKeyDown);
    dlg.removeEventListener("close", onClose);
    cleanupPrevious = null;
  };
  cleanupPrevious = cleanup;
  dlg.addEventListener("click", onClick);
  dlg.addEventListener("keydown", onKeyDown);
  dlg.addEventListener("close", onClose);
  if (!dlg.open) dlg.showModal();
  textarea.focus();
}

function loadListFile(textarea) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,.tsv,text/plain";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (file) textarea.value = await file.text();
  };
  input.click();
}

function saveListFile(text) {
  const url = URL.createObjectURL(new Blob(["﻿" + text.replace(/\r?\n/g, "\r\n")], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "置換リスト.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
