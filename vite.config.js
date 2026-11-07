import { defineConfig } from "vite";

// GitHub Pages では https://<ユーザー名>.github.io/mieru-editor/ のようにサブフォルダーで公開されるため、
// どこに置いても動くように相対パスで出力する。
export default defineConfig({
  base: "./",
});
