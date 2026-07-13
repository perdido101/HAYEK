/**
 * core/ — HAYEK domain logic. Pure TypeScript: zero framework imports, zero
 * network calls. Everything else depends on core; core depends on nothing.
 * The guard test in tests/core-purity.test.ts fails the build if this is
 * ever violated.
 */
export * from "./trace/schema";
export * from "./trace/cost";
