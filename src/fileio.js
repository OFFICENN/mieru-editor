// ファイルの読み込み・保存(文字コードの判定と変換)
import Encoding from "encoding-japanese";

export const ENCODINGS = ["UTF-8", "UTF-8 (BOM付き)", "Shift_JIS", "EUC-JP", "UTF-16 LE"];

const TEXT_TYPES = [
  {
    description: "テキストファイル",
    accept: { "text/plain": [".txt", ".csv", ".tsv", ".md", ".log", ".ini", ".json", ".xml", ".html", ".css", ".js", ".ts", ".py", ".bat", ".sql"] },
  },
];

/** バイト列を文字列にする。BOM・UTF-8 を優先し、だめなら日本語の文字コードを推定する */
export function decodeBytes(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "UTF-8 (BOM付き)" };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "UTF-16 LE" };
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch {
    // UTF-8 として不正 → 日本語の文字コードを推定
  }
  const detected = Encoding.detect(bytes);
  if (detected === "EUCJP") {
    return { text: new TextDecoder("euc-jp").decode(bytes), encoding: "EUC-JP" };
  }
  return { text: new TextDecoder("shift_jis").decode(bytes), encoding: "Shift_JIS" };
}

/** 文字列を指定の文字コードのバイト列にする */
export function encodeText(text, encoding) {
  switch (encoding) {
    case "UTF-8 (BOM付き)": {
      const body = new TextEncoder().encode(text);
      const out = new Uint8Array(body.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(body, 3);
      return out;
    }
    case "UTF-16 LE": {
      const out = new Uint8Array(2 + text.length * 2);
      out[0] = 0xff;
      out[1] = 0xfe;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        out[2 + i * 2] = c & 0xff;
        out[3 + i * 2] = c >> 8;
      }
      return out;
    }
    case "Shift_JIS":
    case "EUC-JP": {
      const codes = Encoding.convert(Encoding.stringToCode(text), {
        to: encoding === "Shift_JIS" ? "SJIS" : "EUCJP",
        from: "UNICODE",
      });
      return new Uint8Array(codes);
    }
    default:
      return new TextEncoder().encode(text);
  }
}

/** Shift_JIS などで表せない文字があるか調べる(保存前の確認用) */
export function findUnencodable(text, encoding) {
  if (encoding !== "Shift_JIS" && encoding !== "EUC-JP") return [];
  // 表せない文字は「?」(0x3F) 1バイトに置き換わる。〜(U+301C) と ～(U+FF5E) のような
  // 対応表の違いは同じバイトになるだけで情報は失われないので、問題として扱わない。
  const bad = new Set();
  const checked = new Set();
  for (const ch of text) {
    if (bad.size >= 10) break;
    if (ch.charCodeAt(0) < 0x80 || checked.has(ch)) continue;
    checked.add(ch);
    const bytes = encodeText(ch, encoding);
    if (bytes.length === 1 && bytes[0] === 0x3f) bad.add(ch);
  }
  return [...bad];
}

export const canUseFileSystemAccess = typeof window !== "undefined" && "showOpenFilePicker" in window;

/** ファイルを開くダイアログ。{ handle, name, bytes } を返す(キャンセル時は null) */
export async function pickAndReadFile() {
  if (canUseFileSystemAccess) {
    try {
      const [handle] = await window.showOpenFilePicker({ types: TEXT_TYPES, excludeAcceptAllOption: false, multiple: false });
      return await readHandle(handle);
    } catch (e) {
      if (e?.name === "AbortError") return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ handle: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    };
    input.click();
  });
}

export async function readHandle(handle) {
  const file = await handle.getFile();
  return { handle, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

export async function readFileObject(file) {
  return { handle: null, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** 上書き保存。handle が無い・権限が無いときは「名前を付けて保存」に回す。保存先の handle を返す */
export async function writeToHandle(handle, bytes) {
  if (handle.queryPermission && (await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") {
      throw new Error("ファイルへの書き込みが許可されませんでした。");
    }
  }
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return handle;
}

/** 名前を付けて保存。File System Access API が使えないブラウザではダウンロードになる */
export async function saveAs(suggestedName, bytes) {
  if ("showSaveFilePicker" in window) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName, types: TEXT_TYPES });
      await writeToHandle(handle, bytes);
      return handle;
    } catch (e) {
      if (e?.name === "AbortError") return null;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return null;
}
