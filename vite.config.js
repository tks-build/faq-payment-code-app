import react from '@vitejs/plugin-react';
import 'dotenv/config';
import { defineConfig } from 'vite';
import templatesHandler from './api/templates.js';

export default defineConfig({
  plugins: [
    react(),
    {
      // Serves /api/templates from the Vite dev server, so `npm run dev`
      // works without the Vercel CLI. On Vercel the file in api/ is the route.
      name: 'local-templates-api',
      configureServer(server) {
        server.middlewares.use('/api/templates', async (req, res) => {
          const url = new URL(req.url || '', 'http://localhost');
          req.query = Object.fromEntries(url.searchParams.entries());
          req.method = req.method || 'GET';

          const response = {
            statusCode: 200,
            status(code) {
              this.statusCode = code;
              return this;
            },
            json(body) {
              res.statusCode = this.statusCode;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(body));
            },
          };

          await templatesHandler(req, response);
        });
      },
    },
  ],
});
