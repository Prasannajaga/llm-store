# Input-to-LLM Flow (Current Architecture)

## Scope
This document describes the current runtime flow from chat input submission to streamed LLM response rendering and persistence.

Primary files:
- `src/components/input/ChatInput.tsx`
- `src/components/chat/ChatArea.tsx`
- `src/hooks/useStreaming.ts`
- `src/services/streamService.ts`
- `src/services/sseParser.ts`
- `src/services/knowledgeService.ts`
- `src/services/messageService.ts`
- `src/store/modelStore.ts`
- `src/store/settingsStore.ts`
- `src/constants/index.ts`

## End-to-End Sequence
```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant CI as ChatInput
    participant KS as KnowledgeService
    participant CA as ChatArea
    participant MS as MessageService
    participant US as UseStreaming
    participant SS as StreamService
    participant MD as ModelAndSettingsStore
    participant LLM as LLMServer
    participant EB as EventBus

    U->>CI: Type prompt
    Note over CI: Slash mode starts when input starts with slash and has no space
    CI->>KS: listDocuments on mount
    KS-->>CI: Return knowledge docs
    U->>CI: Optional select knowledge chips

    U->>CI: Enter or click Send
    CI->>CA: onAsk with prompt and selected IDs or null

    CA->>MS: saveMessage user message
    MS-->>CA: Success

    alt Selected IDs present
        CA->>KS: searchVector per selected document
        KS-->>CA: Per document matches
    else No selected IDs
        CA->>KS: searchVector across all documents
        KS-->>CA: Global matches
    end

    CA->>CA: Build augmented prompt with context chunks

    CA->>US: generate with augmented prompt
    US->>SS: register token stream listener
    US->>SS: register complete listener
    US->>SS: register error listener

    SS->>MD: Read URL and generation params
    SS->>LLM: POST completion with stream true
    LLM-->>SS: Return SSE chunks

    loop For each SSE chunk
        SS->>SS: Parse SSE payload and JSON
        SS->>EB: Emit token stream event
        EB-->>US: Token stream event received
        US->>US: Buffer tokens and flush every 32ms
        US-->>CA: Update current stream
        CA-->>U: Update streaming assistant message
    end

    SS->>EB: Emit generation complete
    EB-->>US: Complete event received
    US->>CA: onComplete with full text

    CA->>MS: saveMessage assistant message
    MS-->>CA: Success
    CA-->>U: Render final assistant message
```

## Control Flow (Decision View)
```mermaid
flowchart TD
    A[User input in ChatInput] --> B{Slash lookup mode}
    B -->|Yes| C[Show filtered knowledge docs]
    C --> D[Select docs to chips]
    D --> E[Back to free text input]
    B -->|No| E

    E --> F[Submit onAsk with prompt and ids or null]
    F --> G[ChatArea creates and saves user message]
    G --> H{Knowledge IDs selected}
    H -->|Yes| I[Vector search per selected doc]
    H -->|No| J[Vector search across all docs]
    I --> K[Compose context and augmented prompt]
    J --> K

    K --> L[useStreaming generate]
    L --> M[streamService generateStream]
    M --> N[Resolve URL and params from stores]
    N --> O[HTTP stream completion endpoint]
    O --> P[Parse SSE and emit token stream]
    P --> Q[Buffered UI updates in useStreaming]
    Q --> R[ChatArea shows live assistant stream]

    O --> S{Complete cancel or error}
    S -->|complete| T[Emit generation complete]
    S -->|abort| T
    S -->|error| U[Emit generation error]
    T --> V[onComplete full text]
    U --> W[Set error and maybe partial onComplete]
    V --> X[Save assistant message]
    W --> X
```

## Runtime State Machine (Generation)
```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Submitting: Enter or Send
    Submitting --> RetrievingKnowledge: onAsk starts
    RetrievingKnowledge --> PromptComposed: context built or skipped
    PromptComposed --> Streaming: generateStream started

    Streaming --> Streaming: token stream events
    Streaming --> Completed: generation complete
    Streaming --> Error: generation error
    Streaming --> Cancelled: abort controller fired

    Completed --> Persisting: onComplete with full text
    Error --> Persisting: partial text may be saved
    Cancelled --> Persisting: partial or empty text may be saved

    Persisting --> Idle: assistant message saved
```

## Current Notes Relevant for Agent Harness Eval
- Chat retrieval path currently uses **vector search only** in chat (`searchVector`) even though Knowledge screen supports Vector and Graph mode.
- If no chip is selected, chat defaults to **all knowledge** (`ids = null`).
- Knowledge context is injected as plain text prefix into prompt (no structured tool call protocol yet).
- Streaming path is event based (`token_stream`, `generation_complete`, `generation_error`).
- Token rendering is buffered at about 32ms in `useStreaming` to reduce rerenders.
- Cancellation uses `AbortController`; completion event is still emitted on abort.
- On errors or cancel, partial text can still be persisted via `onComplete` path.

## Recommended Harness Hook Points (for next phase)
1. `pre_submit`: validate inputs, policy checks, test case tags.
2. `retrieval_plan`: choose vector, graph, or hybrid before retrieval.
3. `context_assembly`: deterministic chunk packing and token budget tracking.
4. `prompt_compile`: final prompt template and trace metadata.
5. `stream_observer`: token level telemetry, latency, and stop reason.
6. `post_completion_eval`: factuality checks, citation coverage, safety.
7. `persistence_gate`: decide whether to store partial or empty outputs.

## Quick Trace IDs You Can Add Later
- `request_id` per user send
- `retrieval_mode` vector graph hybrid
- `selected_doc_ids`
- `retrieved_chunk_ids`
- `prompt_tokens_est`
- `first_token_latency_ms`
- `stream_duration_ms`
- `finish_reason`
- `persisted_message_id`
