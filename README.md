
# MSK Annotation Suite

Clinical measurement toolkit for knee MRI — TT-TG, Insall–Salvati, Patellar Tilt, and Sulcus Angle with DICOM support and structured CSV export.

[![License](https://img.shields.io/badge/license-PolyForm--Noncommercial--1.0.0-blue)](LICENSE)

## Running the code

```bash
npm install
npm run dev
```

## Deploying to Render

This project is configured for one-click deployment on [Render](https://render.com) as a static site.

1. Push this repo to GitHub/GitLab
2. On Render, create a new **Static Site**
3. Connect your repository
4. Render will auto-detect the `render.yaml` config, or set manually:
   - **Build Command:** `npm install && npm run build`
   - **Publish Directory:** `dist`

The `render.yaml` Blueprint also enables PR previews and SPA routing (client-side routes rewritten to `index.html`).

## License

PolyForm Noncommercial License 1.0.0 — free for personal, educational, academic research, and noncommercial clinical use. Commercial use requires a separate license. See [LICENSE](LICENSE) for full terms.
