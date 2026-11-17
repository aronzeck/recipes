# My Recipes

A personal recipe book that runs in the browser and installs on iPhone / iPad like an app.
No server, no account — everything is stored on your device.

## Features

- **Dictate or type** ingredients, steps and notes. Tap 🎤 next to a field and talk.
  - Say **“next ingredient”** or **“new line”** to start a new ingredient line.
  - Say **“next step”** to automatically split into a new step.
  - Say **“comma”** / **“period”** for punctuation.
  - The 🎤 on the iOS keyboard works in every field too.
- **Photos & videos** (optional) on each step and on the finished dish. Photos are resized to save space.
- **Search** by name, ingredient or tag; filter by tag.
- **Cook mode**: tick off ingredients, tap steps to mark them done, keep the screen awake.
- **Share** a recipe as text (Messages, Notes, etc.).
- **Works offline** once opened.
- **Backup / transfer**: Settings ⚙︎ → Export creates one file (save it to iCloud Drive); Import it on another device.

## Put it online with GitHub Pages (free)

1. Merge this code into the `main` branch.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)` → **Save**.
3. After a minute it's live at `https://<your-username>.github.io/recipes/`.

> GitHub Pages on a **private** repo needs a paid GitHub plan. On a free plan, make the repo public —
> only the app's code is public; your recipes stay on your devices and are never uploaded.

## Install on iPhone / iPad

1. Open the link in **Safari**.
2. Tap **Share → Add to Home Screen**.
3. Launch **Recipes** from the home screen. The first time you tap 🎤, allow microphone access.

Each device keeps its own recipes. Use **Export / Import** in Settings to copy them between your phone and iPad.

## Run locally (for development)

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell |
| `app.js` | Screens: list, recipe, editor, settings |
| `dictation.js` | Speech-to-text and voice commands |
| `db.js` | On-device storage (IndexedDB) |
| `sw.js` | Offline support. Bump `VERSION` after changing files |
| `styles.css` | Styling (light & dark mode) |
