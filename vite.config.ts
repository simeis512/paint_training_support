import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import os from 'node:os'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // このリポジトリは Dropbox 配下にあり、node_modules/.vite の rename が
  // 同期プロセスのロックで EBUSY になるため、依存キャッシュを Dropbox 外に置く
  cacheDir: path.join(os.tmpdir(), 'atelierloop-vite-cache'),
  server: {
    // PORT 環境変数があれば従う（プレビューツールの自動ポート割り当て用）。既定は 5173
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
})
