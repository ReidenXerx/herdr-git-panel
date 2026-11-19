# Image sources

The README and gallery images are HTML cards rendered to PNG with Playwright (Chromium).
Fonts are bundled in `fonts/` (Geist and JetBrains Mono, SIL Open Font License, see the
`LICENSE-*.txt` files). Icons are the panel's own, from `mods/git-panel/icons/`, through the
`icons` link in this folder.

The preview is a mock, not a screenshot: a Herdr window drawn in HTML, with the Git panel laid out
as `mods/git-panel/main.js` draws it (header, commit box, Staged / Changes / Stashes / Commits, and
the diff below the lists) at 1.12× the panel's sizes. The repository, files, commits and terminal
output in it are made up.

## Re-render

Playwright isn't a dependency of this repo. Install it just for this folder (node_modules is
git-ignored), or point `PLAYWRIGHT_MODULE` at a folder that has it:

```sh
cd assets/src
npm i --no-save playwright && npx playwright install chromium
```

Then:

```sh
cd assets/src
node render.mjs preview.html   ../../preview.png        1600 1000
node render.mjs card-keys.html ../card-keys.png         1600 1000
node render.mjs logo.html      ../logo-512.png           512  512
```

`logo.svg` here and in `assets/` is the logo itself: a branch, in the same tile, grey and blue as
the Quick Open and Editor logos. `logo-small.html` checks how it reads at 64, 32 and 16 px.
Each card sets `window.__ready = true` once its fonts, icons and images have loaded; `render.mjs`
waits for that and exits 1 on any page error or missing image.
