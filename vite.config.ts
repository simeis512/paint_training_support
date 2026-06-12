import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // PORT 環境変数があれば従う（プレビューツールの自動ポート割り当て用）
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
  },
})
