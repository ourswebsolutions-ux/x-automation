import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const root = process.cwd()

function teamEmailSettings(): Record<string, string> {
  const names = ['XAUTO_SMTP_HOST', 'XAUTO_SMTP_PORT', 'XAUTO_SMTP_SECURE', 'XAUTO_SMTP_USER', 'XAUTO_SMTP_PASS', 'XAUTO_SMTP_FROM', 'XAUTO_ADMIN_EMAIL', 'XAUTO_PLAN_CURRENCY', 'XAUTO_PRICE_MONTHLY', 'XAUTO_PRICE_SIX_MONTHS', 'XAUTO_PRICE_LIFETIME', 'XAUTO_PLAN_MONTHLY_DAYS']
  return Object.fromEntries(names.flatMap((name) => (process.env[name] ? [[name, process.env[name] as string]] : [])))
}

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
    resolve: { alias: { '@shared': shared } },
    // The activation server's public address. Not a secret; prices and keys stay on that server.
    define: {
      __ACTIVATION_URL__: JSON.stringify(process.env.XAUTO_ACTIVATION_URL ?? ''),
      // Only the private team installer (scripts/build-team-installer.mjs) sets XAUTO_TEAM_BUILD;
      // every other build, including GitHub releases, gets null.
      __XAUTO_TEAM_EMAIL__: JSON.stringify(process.env.XAUTO_TEAM_BUILD === '1' ? teamEmailSettings() : null)
    }
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
