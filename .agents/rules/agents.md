# AGENT GOVERNANCE & PROJECT ARCHITECTURE

This project is a high-performance, secure **Tauri + React** desktop application designed for macOS, Linux, and Windows. All agents must strictly adhere to these rules to ensure consistency, security, and maintainability.

## 1. CORE DIRECTIVES

- **Technology Stack**: React (Frontend), TypeScript (Linguistic Layer), Tauri/Rust (Core/Backend).
- **Multi-Platform Focus**: All code must be cross-platform compatible. Avoid platform-specific APIs unless wrapped in conditional logic (e.g., `window.__TAURI__`).
- **No Spontaneous Creation**: Do not create new files or directories unless explicitly instructed to "create," "implement," or "initialize" a new component/module.
- **Strict Structure Adherence**: Follow the existing directory hierarchy and architectural patterns without deviation.
- **Strict Layer Boundary**:
  - **Backend business logic must live in Rust only** (`src-tauri/src/**`).
  - **Frontend TypeScript must be UI and interaction orchestration only** (`src/**`).
  - Frontend may call backend commands/services, but must not contain core retrieval logic, ranking logic, prompt construction policy logic, or fallback policy logic.

## 1A. ENFORCED BACKEND VS FRONTEND OWNERSHIP

- **Rust-only responsibilities**:
  - Retrieval planning (vector/graph/hybrid decisioning)
  - Knowledge query execution
  - Context dedupe and rerank
  - Prompt construction policy and fallback policy
  - Safety and governance checks tied to generation
  - Streaming orchestration and completion/error handling policy
  - Persistence decisions and audit metadata
- **TypeScript-only responsibilities**:
  - UI rendering and UX state
  - Input controls and interaction events
  - Displaying streamed tokens and errors
  - Calling typed Tauri commands and rendering results
- **Disallowed in TypeScript**:
  - Dedupe/rerank algorithms
  - Retrieval mode policy logic
  - Prompt template assembly for system-level policy
  - Backend fallback chains
- **Allowed in TypeScript**:
  - Lightweight formatting for display only (e.g., truncation, sorting purely for visual presentation)

## 2. TAURI & RUST BEST PRACTICES (SECURITY & IPC)

- **Isolation Pattern**: Always use the Tauri Isolation pattern where possible to prevent frontend vulnerabilities from accessing the system.
- **Commands & IPC**: Use strongly-typed Tauri commands for any system-level operations. Avoid `eval` or insecure string interpolation in IPC calls.
- **State Management**: Manage application state primarily in the Rust core for sensitive data; use React state/context only for UI-specific data.
- **Resource Management**: Properly handle window lifecycle events and guest-window management to prevent memory leaks.
- **Command-First Backend**: Any feature that affects data correctness, ranking, fallback behavior, or generation policy must be implemented as Rust commands and invoked from TS.

## 3. FRONTEND & REACT STANDARDS

- **TypeScript Strictness**: Use strict typing. Avoid `any`. Define interfaces for all props and state objects.
- **Component Architecture**: Use functional components with hooks. Prefer composition over inheritance.
- **Styling**: Use the established styling solution (e.g., CSS Modules, Tailwind, or Styled Components) as found in the current codebase. No inline styles.
- **Performance**: Use `React.memo`, `useMemo`, and `useCallback` strategically to prevent unnecessary re-renders in the desktop environment.

## 3A. UX & VISUAL CONSISTENCY (MANDATORY)

- **Single Visual Language**: New UI elements must match existing app surfaces (`bg-[#212121]`, neutral grays, subtle borders) and avoid introducing disconnected color systems.
- **Low-Contrast Dark Theme**: Avoid high-contrast pure black containers (`#000`) unless explicitly requested. Prefer soft gray layers and subtle depth.
- **Minimal Popovers/Modals**: Keep plus/tool menus and modals simple:
  - one base surface color
  - light border hierarchy
  - limited accent usage (accents only for state emphasis, not full-panel backgrounds)
- **Consistent Controls**:
  - border radius: reuse existing rounded tokens (`rounded-lg`, `rounded-xl`)
  - hover states: subtle neutral hover before accent hover
  - focus states: visible but restrained rings
- **Spacing Rhythm**: Maintain consistent spacing scale already used in the project (`p-3`, `p-4`, `gap-2`, `gap-3`) to avoid visual jitter between panels.
- **Scroll Behavior UX**: Auto-scroll must never fight manual user scrolling. If user scrolls up, auto-follow should pause until user returns near bottom.
- **Design Changes Scope**: When redesigning a component, keep behavior unchanged unless the task explicitly requests interaction changes.

## 4. CODE HYGIENE & DOCUMENTATION

- **Zero-Boilerplate Policy**: Do not include "default" comments provided by IDEs or frameworks (e.g., `// This is a component`).
- **No Dead Code**: Do not leave commented-out code blocks or unused imports. Use tool-driven linting (ESLint/Prettier) if available.
- **Meaningful Comments Only**:
  - **DO NOT** comment on what the code is doing (the code should be self-documenting).
  - **DO** comment on *why* a specific, non-obvious decision was made (e.g., "Workaround for Windows-specific DPI scaling issue").
- **Documentation**: Keep `README.md` and other documentation files updated if a major architectural change is explicitly requested.

## 5. REPOSITORY GOVERNANCE

- **Commit Messages**: Use conventional commits (e.g., `feat:`, `fix:`, `refactor:`) if modifying the history.
- **File Naming**: Follow the existing naming convention (e.g., PascalCase for components, camelCase for utilities).
- **External Dependencies**: Do not add new `npm` or `cargo` packages unless explicitly approved or required for a requested feature.
- **Architecture Review Gate (Mandatory)**:
  - When changing prompt/retrieval/generation flow, include a short architecture note in docs describing:
    - Which layer changed
    - Why the change is in Rust or TS
    - Fallback behavior
  - Reject changes that move backend policy logic into frontend TS unless explicitly approved.

---
**Violation of these rules will result in a failed implementation. If unsure, request clarification before proceeding.**
