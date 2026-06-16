# PePe Terminal(SSH) - Project Instructions

This project is a sophisticated SSH terminal client. Follow these instructions to maintain consistency and quality.

## Architecture
- **Frontend:** React with TypeScript, Vite as the build tool.
- **Backend (Electron):** Main process handles SSH, SFTP, WebDAV, and JDBC bridge.
- **JDBC Sidecar:** A Java application that provides JDBC connectivity. Communication happens via a bridge in `electron/jdbcBridge.ts`.
- **Styles:** Vanilla CSS (see `src/App.css`, `src/index.css`).

## Conventions
- **TypeScript:** Strict typing is preferred. Avoid `any`.
- **Components:** Functional components with hooks.
- **i18n:** Use `react-i18next` for translations. Add new keys to all files in `resources/i18n/`.
- **Error Handling:** Use the `ErrorBoundary` component for UI parts and consistent logging in the Electron process.

## Common Tasks
- **Building:** `npm run build` handles all sidecar builds, JRE downloads, and packaging.
- **Development:** `npm run dev` starts the Vite dev server.
- **Linting:** `npm run lint` uses ESLint.

## Directory Structure
- `electron/`: Electron main process and bridges.
- `src/`: React frontend source code.
- `java-sidecar/`: Java source for JDBC bridge.
- `resources/`: Assets, i18n, and bundled drivers.
- `scripts/`: Build and maintenance scripts.
- `docs/`: Manual and release notes.
