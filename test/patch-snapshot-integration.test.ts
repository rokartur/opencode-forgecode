/**
 * Thin integration-test module that aggregates the patch↔snapshot
 * integration scenarios spread across patch-tool and harness-integration
 * suites.  Run this file for a quick smoke test of the patch+snapshot flow.
 *
 *   bun test test/patch-snapshot-integration.test.ts
 */

// Re-export the relevant test suites so `bun test` picks them up when
// this file is targeted directly.
import './patch-tool.test'
import './harness-integration.test'
