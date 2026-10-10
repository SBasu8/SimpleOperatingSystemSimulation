# Dark Store Dispatch — static edition

The same game as the Flask project one folder up, but **everything runs in the
browser**: the map, the simulation and the route optimizer. There is no server, so
any static host works, including GitHub Pages.

| File | Role |
|---|---|
| `index.html`, `style.css` | Page and layout (same as the Flask version) |
| `app.js` | Map, placement, simulation, re-planning. Calls the solver instead of `/api/optimize` |
| `optimizer.js` | JavaScript port of `../optimizer.py`. Same model and algorithms, exposed as `solveDispatch(data)` |
| `worker.js` | Runs `optimizer.js` in a Web Worker so the map keeps animating while it solves |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is |

The solver takes the same input and returns the same output as the Python API. See
the main [README](../README.md#optimization-algorithms-optimizerpy) for the algorithms:
split dynamic program, cheapest insertion and simulated annealing. JavaScript is about
10–15× faster than the Python version, so each time budget gets many more
annealing iterations.

## Run locally

Browsers block Web Workers on `file://` pages. Opening `index.html` directly still
works, because the solver then falls back to the main thread (the map freezes briefly
during each solve). For the full experience, serve the folder:

```bash
python -m http.server 8000 --directory static-site
```

Then open http://localhost:8000.

## Deploy to GitHub Pages

**Option A: GitHub Actions** (the workflow is included at `.github/workflows/deploy-pages.yml`)

1. Push this repository to GitHub, using `main` as the default branch.
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Every push that changes `static-site/` redeploys the site to
   `https://<user>.github.io/<repo>/`.

**Option B: no workflow**

Copy the contents of `static-site/` into a repository's root (or into a `docs/`
folder). Then go to **Settings → Pages → Deploy from a branch** and pick that
branch and folder.

All paths are relative, so the site works under a `/<repo>/` sub-path.
