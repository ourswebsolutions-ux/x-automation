import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = process.cwd()

const shared = resolve(root, 'src/shared')

/**
 * Injects the Content-Security-Policy. Production is strict; development
 * additionally allows the inline React Refresh preamble, injected <style>
 * tags and the HMR websocket.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'relay:csp',
    transformIndexHtml(html, ctx) {
      const dev = Boolean(ctx.server)
      const policy = [
        "default-src 'self'",
        dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
        dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
        "img-src 'self' data: blob: relay-asset:",
        "font-src 'self' data:",
        dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'"
      ].join('; ')
      return html.replace('<!-- csp -->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`)
    }
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } }
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        // Sandboxed preloads cannot `require` arbitrary modules, so emit a
        // single self-contained CommonJS bundle.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve(root, 'src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    build: { minify: 'esbuild', sourcemap: false }
  }
})
