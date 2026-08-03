# Public release preparation

- Source: `agentBayDemo`
- Target: the same working tree, initialized as a new clean Git repository
- License: MIT
- Excluded: `node_modules/`, `dist/`, `.env*` except `.env.example`, `.pi/`, `.agent/`, logs and test temp output
- Included: source, tests, docs, screenshots, Playwright WebM/trace, sanitized Pi handoff, complete iMessage transcript, and the AgentBay Alibaba Cloud skill
- Credentials: no API Key or token is copied; runtime secrets remain in the user config/environment
- History: there was no source Git repository, so the public repository begins with one clean initial commit
