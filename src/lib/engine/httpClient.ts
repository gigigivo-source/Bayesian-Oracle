// Re-export the canonical resilient client so engine modules can use
// a clean relative import ("./httpClient") without duplicating the implementation.
export { resilientJson } from "@/lib/httpClient";
