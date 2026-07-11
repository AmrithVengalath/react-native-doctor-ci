/**
 * MSW (Mock Service Worker) server setup for testing.
 * @packageDocumentation
 */

import { setupServer } from "msw/node";
import { createFixtureHandlers } from "./http-fixtures/handlers.js";

/**
 * Create and return a configured MSW server for test fixtures.
 */
export function createMswServer() {
  return setupServer(...createFixtureHandlers());
}
