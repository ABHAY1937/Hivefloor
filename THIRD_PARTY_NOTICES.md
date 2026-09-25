# Third-party notices

Hivefloor is proprietary software, © 2026 Abhay, all rights reserved (see [LICENSE](LICENSE)).
It uses the open-source work below. Each component keeps its own license, and all of
them permit use in proprietary software as long as their notices are kept.

## Prior art: munder-difflin

Hivefloor's concept, an office of AI coding agents shown on a pixel-art floor with a
boss agent, is inspired by
[munder-difflin](https://github.com/chaitanyagiri/munder-difflin). Hivefloor's harness,
storage, router, terminal layer and renderer were written independently (see README →
*Why it's faster than the reference design*). To the extent any portion is derived
from munder-difflin's source code, that portion is used under its MIT License:

> MIT License — Copyright (c) 2026 Chaitanya Giri
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify,
> merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following
> conditions: The above copyright notice and this permission notice shall be included
> in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS
> IS", WITHOUT WARRANTY OF ANY KIND.

Hivefloor does **not** include munder-difflin's bundled art (the LimeZu "Modern
Interiors" tileset, which has its own license). All Hivefloor avatars and office
graphics are drawn procedurally in `src/renderer/src/floor/`.

## Runtime dependencies (shipped in the app)

| Package | License |
|---|---|
| [Electron](https://github.com/electron/electron) (includes Chromium and Node.js) | MIT. Chromium's component licenses ship as `LICENSES.chromium.html` inside every installer |
| [React](https://github.com/facebook/react), react-dom | MIT |
| [xterm.js](https://github.com/xtermjs/xterm.js) (`@xterm/xterm`, `@xterm/addon-fit`) | MIT |
| [node-pty](https://github.com/microsoft/node-pty) | MIT |

Build-time tools (Vite, electron-vite, electron-builder, TypeScript, tsx, Playwright)
are not shipped. They use MIT, ISC, BSD, Apache-2.0 and BlueOak licenses; the full list
is in `package-lock.json`. Generate a full report with `npx license-checker --summary`.

## Agents you connect

Hivefloor launches third-party CLIs you install yourself (Claude Code, Codex, Gemini
CLI, Aider, OpenCode). They are not distributed with Hivefloor, and your use of them and
their model APIs is governed by their own terms.

## Trademarks

"Hivefloor" and its logo belong to the copyright holder. All other product names are
trademarks of their respective owners.
