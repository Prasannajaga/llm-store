# llm-store

Desktop local-LLM chat app built with:
- React + TypeScript (UI)
- Tauri + Rust + SQLite (desktop backend/storage)

## Quick Start

```bash
npm install
npm run dev
```

In a second terminal:

```bash
cd src-tauri
cargo check
```

## Quality Commands

```bash
npm run lint
npm run test
npm run build
cd src-tauri && cargo test && cargo check
```

## Architecture

- `src/components` UI (chat, sidebar, settings, feedback, markdown rendering)
- `src/store` Zustand state stores
- `src/services` IPC + streaming + utility services
- `src-tauri/src/commands` Tauri commands (chat/message/model/settings/feedback)
- `src-tauri/src/storage` SQLx persistence layer
- `src-tauri/migrations` SQLite schema migrations

## Notes

- Local models discovered from app model directory are treated as non-removable UI entries.
- Registered external model paths can be removed from the DB list.
- Streaming parser handles chunk-split SSE frames safely.
