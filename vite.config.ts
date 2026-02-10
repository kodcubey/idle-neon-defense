import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    {
      name: 'redirect-game-to-slash',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/game') {
            res.statusCode = 302
            res.setHeader('Location', '/game/')
            res.end()
            return
          }
          next()
        })
      },
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === '/game') {
            res.statusCode = 302
            res.setHeader('Location', '/game/')
            res.end()
            return
          }
          next()
        })
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        game: resolve(__dirname, 'game/index.html'),
      },
    },
  },
})
