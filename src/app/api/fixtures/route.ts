// Route handlers live in ./core.ts so Next.js route files export only
// the fields allowed by the App Router type validator. Config fields
// stay local because Next statically parses them at build time.
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export { GET } from "./core";
