# AGENT GOVERNANCE & PROJECT ARCHITECTURE

This project is a high-performance, secure **Tauri + React** desktop application designed for macOS, Linux, and Windows. All agents must strictly adhere to these rules to ensure consistency, security, and maintainability.

## 1. CORE DIRECTIVES

- **Technology Stack**: React (Frontend), TypeScript (Linguistic Layer), Tauri/Rust (Core/Backend).
- **Multi-Platform Focus**: All code must be cross-platform compatible. Avoid platform-specific APIs unless wrapped in conditional logic (e.g., `window.__TAURI__`).
- **No Spontaneous Creation**: Do not create new files or directories unless explicitly instructed to "create," "implement," or "initialize" a new component/module.
- **Strict Structure Adherence**: Follow the existing directory hierarchy and architectural patterns without deviation.

## 2. TAURI & RUST BEST PRACTICES (SECURITY & IPC)

- **Isolation Pattern**: Always use the Tauri Isolation pattern where possible to prevent frontend vulnerabilities from accessing the system.
- **Commands & IPC**: Use strongly-typed Tauri commands for any system-level operations. Avoid `eval` or insecure string interpolation in IPC calls.
- **State Management**: Manage application state primarily in the Rust core for sensitive data; use React state/context only for UI-specific data.
- **Resource Management**: Properly handle window lifecycle events and guest-window management to prevent memory leaks.

## 3. FRONTEND & REACT STANDARDS

- **TypeScript Strictness**: Use strict typing. Avoid `any`. Define interfaces for all props and state objects.
- **Component Architecture**: Use functional components with hooks. Prefer composition over inheritance.
- **Styling**: Use the established styling solution (e.g., CSS Modules, Tailwind, or Styled Components) as found in the current codebase. No inline styles.
- **Performance**: Use `React.memo`, `useMemo`, and `useCallback` strategically to prevent unnecessary re-renders in the desktop environment.

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

---
**Violation of these rules will result in a failed implementation. If unsure, request clarification before proceeding.**
