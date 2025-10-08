import { afterEach, mock } from "bun:test"

// Global setup for all tests in this directory
// Automatically restore all mocks after each test
afterEach(() => {
  mock.restore()
})
