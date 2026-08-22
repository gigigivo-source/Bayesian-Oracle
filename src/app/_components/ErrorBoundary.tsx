"use client";

import { Component, type ReactNode } from "react";
import { ACTION_BLUE } from "./design";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string | null;
}

/**
 * Catches render-time errors in a UI subtree and shows a themed fallback
 * instead of white-screening the whole app.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : "Unexpected error" };
  }

  componentDidCatch(error: unknown) {
    // Surface for debugging without crashing the UI
    console.error("UI error boundary caught:", error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="responsive-card w-full rounded-lg border border-slate-700 bg-slate-900 text-center">
          <div className="mb-3 text-2xl">⚠️</div>
          <div className="mb-2 text-base font-bold text-slate-300 sm:text-lg">Something went wrong rendering this section</div>
          {this.state.message && (
            <p className="mx-auto mb-4 max-w-md break-words font-mono text-sm text-slate-400">{this.state.message}</p>
          )}
          <button
            onClick={() => this.setState({ hasError: false, message: null })}
            className={ACTION_BLUE}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
