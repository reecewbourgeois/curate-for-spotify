import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { devtools } from '@tanstack/devtools-vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

function githubPagesFallbackPlugin(): Plugin {
  let outDir = 'dist'
  return {
    name: 'github-pages-404-fallback',
    configResolved(resolved) {
      outDir = resolved.build.outDir
    },
    closeBundle() {
      const indexPath = resolve(outDir, 'index.html')
      const fallbackPath = resolve(outDir, '404.html')
      if (existsSync(indexPath)) {
        copyFileSync(indexPath, fallbackPath)
      }
    },
  }
}

const config = defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  server: {
    host: '127.0.0.1',
    port: 3000,
  },
  preview: {
    host: '127.0.0.1',
    port: 3000,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    viteReact(),
    githubPagesFallbackPlugin(),
  ],
})

export default config
