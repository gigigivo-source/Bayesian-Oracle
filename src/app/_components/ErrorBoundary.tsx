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
        <div className="bg-black/50 rounded-lg p-10 text-center">
          <div className="text-2xl mb-3">⚠️</div>
          <div className="text-lg font-bold text-slate-300 mb-2">Something went wrong rendering this section</div>
          {this.state.message && (
            <p className="text-xs text-slate-500 font-mono mb-4 max-w-md mx-auto truncate">{this.state.message}</p>
          )}
          <button
            onClick={() => this.setState({ hasError: false, message: null })}
            className={`${ACTION_BLUE} px-4 py-2 text-xs`}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
