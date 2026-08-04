# Expense Tracker

A premium, dark-themed, offline-first Progressive Web App for tracking monthly
income, expenses, and savings — built with plain HTML, CSS, and vanilla
JavaScript. No frameworks, no build tools, no backend.

## Features

- **Hero savings card** — live Monthly Savings figure with a status badge and message.
- **Editable Monthly Income** — tap the Income stat to open a modal and set/update it any time. Prompted automatically on first launch.
- **Add / Edit / Delete expenses** via a smooth bottom sheet (blurred backdrop, slide-up animation).
- **Recurring vs One-time** expense types, grouped into collapsible sections with running totals.
- **Automatic calculations** — Expenses, Savings (Income − Expenses), and Savings Rate `(Savings ÷ Income) × 100` update live and are rounded to one decimal place.
- **Reset Month** — confirmation modal, then deletes all one-time expenses while keeping recurring ones.
- **Download PDF** — generates a professional report (`Expense_Report_<Month>_<Year>.pdf`) with income, recurring/one-time breakdowns, totals, savings, and savings %, using jsPDF (bundled locally, no CDN required).
- **LocalStorage persistence** — all data lives only on the device. Nothing is sent anywhere.
- **Installable PWA** — manifest + service worker with full offline caching, works on Android, iPhone, and desktop.
- **Safe-area aware** — respects the notch / Dynamic Island / home indicator, supports portrait and landscape.
- **Animations** — card lift/press states, slide-up + fade modals, list item transitions, all tuned to ~250ms.

## Project structure

```
ExpenseTracker/
├── index.html            Markup for the app shell, dashboard, and all modals
├── styles.css             Design system (dark theme, neon green accents, glass cards)
├── app.js                 State, rendering, modal logic, PDF export, service worker registration
├── jspdf.umd.min.js       Bundled jsPDF library (offline, no CDN dependency)
├── manifest.json          PWA manifest (icons, theme color, display mode)
├── service-worker.js      Cache-first offline strategy
├── icons/
│   ├── icon-192.png
│   ├── icon-512.png
│   └── apple-touch-icon.png
└── README.md
```

## Running locally

Because service workers require a proper origin (not `file://`), serve the
folder with any static file server, for example:

```bash
cd ExpenseTracker
python3 -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

Opening `index.html` directly by double-clicking will still work for the UI
and LocalStorage, but the service worker (and therefore full offline support)
will only register when served over `http://` or `https://`.

## Installing as an app

- **Android / Desktop Chrome:** open the site, then use the browser menu →
  "Install app" (or the install icon in the address bar).
- **iPhone (Safari):** open the site, tap the Share icon, then "Add to Home
  Screen".

Once installed, the app opens full-screen with no browser chrome, uses the
cached assets, and works fully offline.

## Data & privacy

All income and expense data is stored exclusively in the browser's
LocalStorage on your device. There is no backend, no analytics, and no
network request other than the one-time asset downloads needed to cache the
app for offline use.

## Deploying to GitHub Pages

1. Push the contents of `ExpenseTracker/` to a repository.
2. In the repo settings, enable GitHub Pages for the branch/folder you pushed to.
3. Visit the published URL — the app (including install prompts) will work immediately.
