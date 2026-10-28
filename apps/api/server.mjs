// Vercel entrypoint (vercel.json): must exist before the build, so it loads the built server.
// .mjs because Vercel runs it without this folder's package.json ("type": "module").
import './dist/server.js';
