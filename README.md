# llm-store

A local-first desktop chat app for running LLM workflows.

Built with:

- React + TypeScript for UI
- Tauri + Rust for backend commands/orchestration
- SQLite for chats, knowledge docs, and feedback

## What this app does

- Chat with local or custom model endpoints
- Stream tokens in real time
- Add docs/files into a Knowledge store (chunk + embedding + semantic search)
- Collect feedback history and export it in OpenAI-style JSON/JSONL

## Quick start

```bash
npm install
```

Frontend dev:

```bash
npm run dev
```

Desktop app (Tauri shell):

```bash
npx tauri dev
```

## Useful checks

```bash
npm run lint
npm test
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
```

## Core flow (chat)

When user sends a prompt:

1. UI creates/saves user message
2. If pipeline mode is `rust_v1`, app calls `run_chat_pipeline`
3. If `rust_v1` fails at runtime, UI falls back to `legacy`
4. Tokens are streamed via Tauri events
5. Assistant response is shown live, then persisted

### Rust pipeline order (`rust_v1`)

Top-to-bottom layers:

1. `input_normalize` (fail fast)
2. `retrieval_plan` (fallback to vector)
3. `rag_query` (on failure continue with empty context)
4. `dedupe_context` (on failure passthrough raw chunks)
5. `prompt_build` (on failure use minimal safe prompt)
6. `llm_invoke_stream` (terminal if this fails)
7. `persist_messages` (if this fails, response still stays delivered)

Progress events are emitted per layer (`started/success/fallback/failed`).

In UI, user first sees small plan/progress text, then streamed cursor text appears after tokens start. This avoids overlap and feels more natural.

## Knowledge flow

1. User adds files (`txt/md/json/csv/pdf/docx` + code/text formats)
2. File text is extracted
3. Text is chunked
4. Embeddings are generated and stored
5. Search can run in Knowledge view (`vector` or `graph` mode)
6. Chat retrieval currently uses vector path in practice for `rust_v1` chat mode

Knowledge screen now also shows a live ingest indicator (reading/chunking/embedding/saving), so you can see what's happening while indexing.

## Feedback flow

- Like/dislike is saved per assistant message
- Feedback History view supports filtering
- Export buttons provide OpenAI-style datasets:
  - `.jsonl` (one record per line)
  - `.json` (array form)

Record shape is:

- `messages: [{role: "user"}, {role: "assistant"}]`
- `metadata: feedback_id, message_id, rating, created_at, source`

## Project map

- `src/components` UI
- `src/services` frontend service layer + Tauri invokes
- `src/store` Zustand state
- `src-tauri/src/commands` backend command entrypoints
- `src-tauri/src/pipeline` rust_v1 layered pipeline
- `src-tauri/src/storage` DB logic
- `src-tauri/migrations` schema changes
