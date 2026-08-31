import type { NextConfig } from 'next';

// better-sqlite3 is a native addon; its own `bindings` loader needs to run as
// plain CJS via require() at runtime, not get inlined into the bundled server
// chunk (bundling breaks it: __filename isn't defined in that context).
const nextConfig: NextConfig = { serverExternalPackages: ['better-sqlite3', 'bindings'] };

export default nextConfig;
